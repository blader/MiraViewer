"""Small stdlib-only exporter guards: python tests/test_export_efficient_tam.py."""

import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/export-efficient-tam.py"
spec = importlib.util.spec_from_file_location("export_efficient_tam", SCRIPT)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportGuards(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def write(self, relative, contents=b"synthetic fixture"):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
        return path

    def test_import_and_help_need_no_ml_dependencies(self):
        self.assertNotIn("torch", sys.modules)
        self.assertNotIn("onnx", sys.modules)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as stopped:
            exporter.main(["--help"])
        self.assertEqual(stopped.exception.code, 0)

    def test_file_pins_reject_changed_bytes_wrong_size_missing_and_symlink(self):
        path = self.write("source.py")
        expected = exporter.file_record(path)
        self.assertEqual(exporter.verify_file(path, expected), expected)
        with self.assertRaisesRegex(ValueError, "Byte count"):
            exporter.verify_file(path, {**expected, "bytes": expected["bytes"] + 1})
        path.write_bytes(b"changed fixture")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            exporter.verify_file(path, expected)
        link = self.root / "link.py"
        link.symlink_to(path)
        for invalid in (link, self.root / "missing.py"):
            with self.assertRaisesRegex(ValueError, "regular file"):
                exporter.verify_file(invalid, expected)

    def test_archive_verifies_actual_imported_source_without_git_metadata(self):
        relative = "efficient_track_anything/__init__.py"
        source = self.write(relative)
        module = self.write("efficient_track_anything/model.py")
        pins = {relative: hashlib.sha256(source.read_bytes()).hexdigest(),
                "efficient_track_anything/model.py": hashlib.sha256(module.read_bytes()).hexdigest()}
        with patch.object(exporter, "SOURCE_FILES", pins):
            exporter.verify_upstream(self.root, exporter.SOURCE_REVISION)
            self.assertFalse((self.root / ".git").exists())
            with self.assertRaisesRegex(ValueError, "revision"):
                exporter.verify_upstream(self.root, "unreviewed")
            self.write("efficient_track_anything/unused_tool.py")
            exporter.verify_upstream(self.root, exporter.SOURCE_REVISION)
            extra = self.write("efficient_track_anything/model/__init__.py")
            with self.assertRaisesRegex(ValueError, "shadows"):
                exporter.verify_upstream(self.root, exporter.SOURCE_REVISION)
            extra.unlink()
            source.write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                exporter.verify_upstream(self.root, exporter.SOURCE_REVISION)

    def test_output_guard_never_clears_existing_files(self):
        output = self.root / "new"
        exporter.verify_output(output)
        self.assertFalse(output.exists())
        output.mkdir()
        exporter.verify_output(output)
        kept = self.write("new/keep.txt", b"original")
        with self.assertRaisesRegex(ValueError, "nonempty"):
            exporter.verify_output(output)
        self.assertEqual(kept.read_bytes(), b"original")
        link = self.root / "alias"
        link.symlink_to(output, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            exporter.verify_output(link)

    def test_manifest_paths_are_bound_to_the_flat_eight_file_allowlist(self):
        manifest = json.loads(exporter.MANIFEST.read_text())
        self.assertEqual(len(exporter.asset_records(manifest)), 8)
        manifest["graphs"]["encoder"]["path"] = "../encoder.onnx"
        with self.assertRaisesRegex(ValueError, "escape"):
            exporter.asset_records(manifest)

    def test_check_only_runs_all_guards_without_export_or_creating_output(self):
        manifest = json.loads(exporter.MANIFEST.read_text())
        notices = self.root / "notices"
        output = self.root / "output"
        with patch.object(exporter, "verify_upstream") as upstream, \
                patch.object(exporter, "verify_file") as verify, \
                patch.object(exporter.importlib.metadata, "version", side_effect=lambda name: manifest["exportProvenance"][name]), \
                patch.object(exporter, "export_models") as export, \
                contextlib.redirect_stdout(io.StringIO()) as printed:
            exporter.main(["--upstream", str(self.root), "--checkpoint", str(self.root / "weights.pt"),
                           "--output", str(output), "--notices", str(notices), "--check-only"])
        upstream.assert_called_once_with(self.root.resolve(), manifest["upstream"]["revision"])
        self.assertEqual(verify.call_count, 3)
        export.assert_not_called()
        self.assertFalse(output.exists())
        self.assertTrue(json.loads(printed.getvalue())["preflightOnly"])

    def test_dependency_drift_fails_before_export_or_output_creation(self):
        output = self.root / "output"
        with patch.object(exporter, "verify_upstream"), patch.object(exporter, "verify_file"), \
                patch.object(exporter.importlib.metadata, "version", return_value="unreviewed"), \
                patch.object(exporter, "export_models") as export:
            with self.assertRaisesRegex(ValueError, "must be exactly"):
                exporter.main(["--upstream", str(self.root), "--checkpoint", str(self.root / "weights.pt"),
                               "--output", str(output)])
        export.assert_not_called()
        self.assertFalse(output.exists())

    def test_export_byte_drift_preserves_new_files_and_never_changes_pins(self):
        manifest = json.loads(exporter.MANIFEST.read_text())
        contents = b"synthetic pinned asset"
        digest = hashlib.sha256(contents).hexdigest()
        for record in exporter.asset_records(manifest):
            record.update(bytes=len(contents), sha256=digest)
        manifest_path = self.write("manifest.json", json.dumps(manifest).encode())
        before = manifest_path.read_bytes()
        for record in manifest["notices"].values():
            self.write("notices/" + record["path"], contents)
        output = self.root / "output"

        def changed_export(_upstream, _checkpoint, target, specification):
            for record in [*specification["graphs"].values(), *specification["constants"].values()]:
                (target / record["path"]).write_bytes(b"different graph bytes")

        with patch.object(exporter, "MANIFEST", manifest_path), \
                patch.object(exporter, "verify_upstream"), patch.object(exporter, "verify_file"), \
                patch.object(exporter.importlib.metadata, "version", side_effect=lambda name: manifest["exportProvenance"][name]), \
                patch.object(exporter, "export_models", side_effect=changed_export), \
                contextlib.redirect_stdout(io.StringIO()) as printed:
            with self.assertRaisesRegex(ValueError, "separate parity review"):
                exporter.main(["--upstream", str(self.root), "--checkpoint", str(self.root / "weights.pt"),
                               "--output", str(output), "--notices", str(self.root / "notices")])
        self.assertFalse(json.loads(printed.getvalue())["exactManifestBytes"])
        self.assertEqual(len(list(output.iterdir())), 8)
        self.assertEqual((output / "encoder.onnx").read_bytes(), b"different graph bytes")
        self.assertEqual(manifest_path.read_bytes(), before)
        with self.assertRaisesRegex(ValueError, "nonempty"):
            exporter.verify_output(output)


if __name__ == "__main__":
    unittest.main()
