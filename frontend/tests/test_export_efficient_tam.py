"""Small stdlib-only exporter guards: python tests/test_export_efficient_tam.py."""

import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
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

    def query_manifest(self):
        # Tiny graph bytes exercise exporter ownership only; the JS suite tests
        # the actual pinned graph transformation without executing the model.
        source, derived = b"original synthetic graph", b"derived synthetic graph"
        contract = {
            "sourceSha256": hashlib.sha256(source).hexdigest(), "sourceBytes": len(source),
            "sha256": hashlib.sha256(derived).hexdigest(), "bytes": len(derived),
            "queryRows": 1024, "queryChunkRows": 64, "layers": 4, "heads": 1, "keyValueChannels": 256,
            "projectionBufferAllowance": 6,
        }
        manifest = json.loads(exporter.MANIFEST.read_text())
        manifest["graphs"]["memoryAttention"].update(
            sha256=contract["sha256"], bytes=contract["bytes"],
            queryChunking={key: value for key, value in contract.items() if key not in ("sha256", "bytes")},
        )
        return manifest, contract, source, derived

    def test_import_and_help_need_no_ml_dependencies(self):
        self.assertNotIn("torch", sys.modules)
        self.assertNotIn("onnx", sys.modules)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as stopped:
            exporter.main(["--help"])
        self.assertEqual(stopped.exception.code, 0)

    def test_cpu_export_uses_bicubic_even_on_a_positive_mps_host_and_restores_probe(self):
        available = lambda: True
        torch = SimpleNamespace(mps=SimpleNamespace(is_available=available),
                                cuda=SimpleNamespace(is_available=lambda: False))

        def pinned_host_branch():
            # The pinned get_abs_pos branch checks host probes, not tensor.device.
            return "bilinear" if not torch.cuda.is_available() and torch.mps.is_available() else "bicubic"

        with patch.dict(sys.modules, {"torch": torch}):
            self.assertEqual(pinned_host_branch(), "bilinear")
            scoped = exporter.cpu_export_environment()(pinned_host_branch)
            self.assertEqual(scoped(), "bicubic")
            self.assertIs(torch.mps.is_available, available)
            self.assertEqual(pinned_host_branch(), "bilinear")
        self.assertNotIn("torch", sys.modules)

    def test_cpu_export_restores_host_probe_after_failure_and_nested_scope(self):
        for availability in (False, True):
            with self.subTest(availability=availability):
                available = lambda: availability
                torch = SimpleNamespace(mps=SimpleNamespace(is_available=available))
                with patch.dict(sys.modules, {"torch": torch}):
                    with self.assertRaisesRegex(RuntimeError, "export failed"):
                        with exporter.cpu_export_environment():
                            outer_probe = torch.mps.is_available
                            self.assertFalse(outer_probe())
                            with exporter.cpu_export_environment():
                                self.assertFalse(torch.mps.is_available())
                            self.assertIs(torch.mps.is_available, outer_probe)
                            raise RuntimeError("export failed")
                    self.assertIs(torch.mps.is_available, available)
                    self.assertEqual(torch.mps.is_available(), availability)
        self.assertNotIn("torch", sys.modules)

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

    def test_derivation_contract_requires_exact_source_shape_and_output_pins(self):
        manifest, contract, _, _ = self.query_manifest()
        result = SimpleNamespace(returncode=0, stdout=json.dumps(contract), stderr="")
        with patch.object(exporter.subprocess, "run", return_value=result) as run:
            self.assertEqual(exporter.attention_derivation_contract(manifest), contract)
            run.assert_called_once_with(["node", str(exporter.ATTENTION_DERIVATION), "--contract"],
                                        capture_output=True, text=True)
            for field, value in [("sourceSha256", "changed"), ("sourceBytes", 0), ("queryRows", 512),
                                 ("queryChunkRows", 128), ("layers", 3), ("heads", 2), ("heads", True),
                                 ("keyValueChannels", 64), ("projectionBufferAllowance", 5), ("unreviewed", True)]:
                changed = json.loads(json.dumps(manifest))
                changed["graphs"]["memoryAttention"]["queryChunking"][field] = value
                with self.subTest(field=field), self.assertRaisesRegex(ValueError, "shape/source"):
                    exporter.attention_derivation_contract(changed)
            for field, value in [("sha256", "changed"), ("bytes", 0)]:
                changed = json.loads(json.dumps(manifest))
                changed["graphs"]["memoryAttention"][field] = value
                with self.subTest(field=field), self.assertRaisesRegex(ValueError, "graph pin"):
                    exporter.attention_derivation_contract(changed)
        self.assertNotIn("torch", sys.modules)
        self.assertNotIn("onnx", sys.modules)

    def test_derivation_preflight_failure_never_imports_ml_or_creates_output(self):
        manifest, _, _, _ = self.query_manifest()
        path = self.write("manifest.json", json.dumps(manifest).encode())
        output = self.root / "output"
        with patch.object(exporter, "MANIFEST", path), patch.object(exporter, "verify_upstream"), \
                patch.object(exporter, "verify_file"), \
                patch.object(exporter.importlib.metadata, "version", side_effect=lambda name: manifest["exportProvenance"][name]), \
                patch.object(exporter.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="missing tool")), \
                patch.object(exporter, "export_models") as export:
            with self.assertRaisesRegex(ValueError, "Cannot verify attention derivation"):
                exporter.main(["--upstream", str(self.root), "--checkpoint", str(self.root / "weights.pt"),
                               "--output", str(output), "--check-only"])
        export.assert_not_called()
        self.assertFalse(output.exists())
        self.assertNotIn("torch", sys.modules)

    def test_check_only_validates_derivation_without_producing_it(self):
        manifest, contract, _, _ = self.query_manifest()
        path = self.write("manifest.json", json.dumps(manifest).encode())
        output = self.root / "output"
        with patch.object(exporter, "MANIFEST", path), patch.object(exporter, "verify_upstream"), \
                patch.object(exporter, "verify_file"), \
                patch.object(exporter.importlib.metadata, "version", side_effect=lambda name: manifest["exportProvenance"][name]), \
                patch.object(exporter.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(contract), stderr="")) as run, \
                patch.object(exporter, "export_models") as export, \
                patch.object(exporter, "derive_exported_attention") as derive, \
                contextlib.redirect_stdout(io.StringIO()):
            exporter.main(["--upstream", str(self.root), "--checkpoint", str(self.root / "weights.pt"),
                           "--output", str(output), "--check-only"])
        self.assertEqual(run.call_count, 1)
        export.assert_not_called()
        derive.assert_not_called()
        self.assertFalse(output.exists())

    def test_verified_derivation_replaces_only_the_freshly_exported_intermediate(self):
        manifest, contract, source, derived = self.query_manifest()
        path = self.write("output/" + manifest["graphs"]["memoryAttention"]["path"], source)
        kept = self.write("output/other-graph.onnx", b"unchanged")

        def generate(args, **_kwargs):
            self.assertEqual(Path(args[-2]), path)
            self.assertEqual(path.read_bytes(), source)
            Path(args[-1]).write_bytes(derived)
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")

        with patch.object(exporter.subprocess, "run", side_effect=generate):
            exporter.derive_exported_attention(path.parent, manifest, contract)
        self.assertEqual(path.read_bytes(), derived)
        self.assertEqual(kept.read_bytes(), b"unchanged")
        self.assertEqual(sorted(item.name for item in path.parent.iterdir()), sorted([path.name, kept.name]))

    def test_full_export_derives_after_original_generation_and_publishes_only_verified_eight_files(self):
        manifest, contract, source, derived = self.query_manifest()
        unchanged = b"unchanged synthetic asset"
        attention = manifest["graphs"]["memoryAttention"]
        for record in exporter.asset_records(manifest):
            if record is not attention:
                record.update(sha256=hashlib.sha256(unchanged).hexdigest(), bytes=len(unchanged))
        checkpoint = self.write("weights.pt", unchanged)
        manifest["upstream"]["checkpoint"].update(sha256=hashlib.sha256(unchanged).hexdigest(), bytes=len(unchanged))
        manifest_path = self.write("manifest.json", json.dumps(manifest).encode())
        original_manifest = manifest_path.read_bytes()
        for record in manifest["notices"].values():
            self.write("notices/" + record["path"], unchanged)
        output = self.root / "output"
        stages = []

        def generate(_upstream, _checkpoint, target, specification):
            stages.append("original-export")
            for record in [*specification["graphs"].values(), *specification["constants"].values()]:
                (target / record["path"]).write_bytes(source if record["path"] == attention["path"] else unchanged)

        def derive(args, **_kwargs):
            if args[-1] == "--contract":
                stages.append("contract-preflight")
                return SimpleNamespace(returncode=0, stdout=json.dumps(contract), stderr="")
            stages.append("checked-derivation")
            self.assertEqual(Path(args[-2]).read_bytes(), source)
            Path(args[-1]).write_bytes(derived)
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")

        with patch.object(exporter, "MANIFEST", manifest_path), patch.object(exporter, "verify_upstream"), \
                patch.object(exporter.importlib.metadata, "version", side_effect=lambda name: manifest["exportProvenance"][name]), \
                patch.object(exporter, "export_models", side_effect=generate), \
                patch.object(exporter.subprocess, "run", side_effect=derive), \
                contextlib.redirect_stdout(io.StringIO()) as printed:
            exporter.main(["--upstream", str(self.root), "--checkpoint", str(checkpoint),
                           "--output", str(output), "--notices", str(self.root / "notices")])
        self.assertEqual(stages, ["contract-preflight", "original-export", "checked-derivation"])
        self.assertTrue(json.loads(printed.getvalue())["exactManifestBytes"])
        self.assertEqual(sorted(item.name for item in output.iterdir()), sorted(record["path"] for record in exporter.asset_records(manifest)))
        self.assertEqual((output / attention["path"]).read_bytes(), derived)
        self.assertEqual((output / "encoder.onnx").read_bytes(), unchanged)
        self.assertEqual(manifest_path.read_bytes(), original_manifest)
        self.assertNotIn("torch", sys.modules)
        self.assertNotIn("onnx", sys.modules)

    def test_derivation_refuses_source_drift_and_existing_candidate_without_writes(self):
        manifest, contract, source, _ = self.query_manifest()
        path = self.write("output/" + manifest["graphs"]["memoryAttention"]["path"], b"wrong source")
        with patch.object(exporter.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                exporter.derive_exported_attention(path.parent, manifest, contract)
            self.assertEqual(path.read_bytes(), b"wrong source")
            path.write_bytes(source)
            candidate = self.write("output/" + path.name + ".query64", b"keep existing")
            with self.assertRaisesRegex(ValueError, "destination already exists"):
                exporter.derive_exported_attention(path.parent, manifest, contract)
        run.assert_not_called()
        self.assertEqual(path.read_bytes(), source)
        self.assertEqual(candidate.read_bytes(), b"keep existing")

    def test_failed_or_drifted_derivation_preserves_original_and_new_evidence(self):
        for returncode in (0, 1):
            with self.subTest(returncode=returncode):
                manifest, contract, source, _ = self.query_manifest()
                path = self.write(f"output-{returncode}/" + manifest["graphs"]["memoryAttention"]["path"], source)
                candidate = path.with_name(path.name + ".query64")

                def wrong_graph(args, **_kwargs):
                    Path(args[-1]).write_bytes(b"unapproved graph")
                    return SimpleNamespace(returncode=returncode, stdout="{}", stderr="failed")

                with patch.object(exporter.subprocess, "run", side_effect=wrong_graph):
                    with self.assertRaisesRegex(ValueError, "SHA-256" if returncode == 0 else "new files were preserved"):
                        exporter.derive_exported_attention(path.parent, manifest, contract)
                self.assertEqual(path.read_bytes(), source)
                self.assertEqual(candidate.read_bytes(), b"unapproved graph")

    def test_export_byte_drift_preserves_new_files_and_never_changes_pins(self):
        manifest = json.loads(exporter.MANIFEST.read_text())
        # This synthetic fixture isolates the original export's byte-drift guard;
        # checked derivation failures and retained evidence are covered above.
        manifest["graphs"]["memoryAttention"].pop("queryChunking", None)
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
