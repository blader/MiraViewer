#!/usr/bin/env python3
"""Export the manifest-pinned EfficientTAM assets using synthetic tracing inputs only.

Usage: python scripts/export-efficient-tam.py --upstream /path/to/EfficientTAM \
    --checkpoint /path/to/efficienttam_ti_512x512.pt --output /path/to/new-assets

Install the manifest's Torch/ONNX versions separately. This command never downloads
code or weights. --check-only verifies inputs without importing Torch or exporting.
An extracted upstream archive is sufficient; Git metadata is not required.

Output byte identity is checked, not assumed. Any drift preserves the new files and
fails: it requires a separate numerical/runtime parity review, never updated pins.
"""

import argparse
import copy
import hashlib
import importlib.machinery
import importlib.metadata
import json
from pathlib import Path
import sys


FRONTEND = Path(__file__).resolve().parents[1]
MANIFEST = FRONTEND / "src/utils/segmentation/efficientTam/assetManifest.json"
SOURCE_REVISION = "abcd061ebd3cc6e7527d152d75b890126aaa53f6"
# Imported architecture/configuration bytes at the public revision above. These
# pins also verify archives, without trusting a caller-supplied revision label.
SOURCE_FILES = {
    "efficient_track_anything/__init__.py": "1af4ddafeae09ca4124ca80a19e4060b1964892aef13ebf12edb663dbf4e4b5a",
    "efficient_track_anything/build_efficienttam.py": "458fbbd1ca9202d705cc1d43de4d1e2b864bcd66abad7079b9af4bb863614310",
    "efficient_track_anything/configs/efficienttam/efficienttam_ti_512x512.yaml": "55a0142a2d0076d3c434a8a35c23ccc16e7e42ef06153b571f147615befa070d",
    "efficient_track_anything/efficienttam_video_predictor.py": "d06d78e799c5529c7d1e6012676f9dccdccba9e63781a5f50e357658a94152cc",
    "efficient_track_anything/modeling/__init__.py": "34bd8069c54764e7b8d73a78905dbe6467140a2f73170875128f6ca4d8cdd0aa",
    "efficient_track_anything/modeling/backbones/__init__.py": "34bd8069c54764e7b8d73a78905dbe6467140a2f73170875128f6ca4d8cdd0aa",
    "efficient_track_anything/modeling/backbones/image_encoder.py": "3676ba2067f4b1b54446a090546ccf7ed51ab1c9c79a092a142632b5525433f2",
    "efficient_track_anything/modeling/backbones/utils.py": "0dd6b120c8ffa92ea0ff5af86a347b1bc2b53c201f5a3f20710593aed56daf1b",
    "efficient_track_anything/modeling/backbones/vitdet.py": "ab787ee6754c4979baed62ae027be29a1692a14870066b53e22d31d8a1bcc24b",
    "efficient_track_anything/modeling/efficienttam_base.py": "0c45f4c2e31b62a084a01dbe60a33ddc6bc69ef66b8dce699120236c19e56c7a",
    "efficient_track_anything/modeling/efficienttam_utils.py": "cdbcc1ad667ee4f8f4d6ff6665cbfe62de03817cfb928b26e06d269b27a16661",
    "efficient_track_anything/modeling/memory_attention.py": "d98b5561a71f088235812edca0b82dbf4a6fc2ef4d66f7f4c6aa4c3091b84af2",
    "efficient_track_anything/modeling/memory_encoder.py": "ff7e66bcf002ece9f19827aa33e73cf31cade23f7653fa60111a8830ebd31334",
    "efficient_track_anything/modeling/position_encoding.py": "b51404718c0d38f381293c8e5e00a15d129651b7f09b1158002d8974a30967b5",
    "efficient_track_anything/modeling/sam/__init__.py": "34bd8069c54764e7b8d73a78905dbe6467140a2f73170875128f6ca4d8cdd0aa",
    "efficient_track_anything/modeling/sam/mask_decoder.py": "d98bf933cf444817c1e06c482c9be132afc56518275c648519655e6a02ec22f9",
    "efficient_track_anything/modeling/sam/prompt_encoder.py": "2081f5302b176e14f86a3f3fa799a1dcd30b7ba6ad07b14753f413a0703a8fd3",
    "efficient_track_anything/modeling/sam/transformer.py": "60841b896aabbe5e67fef2ed6cc2bb0f2703657a9fadb99955d1a81dd732a1c4",
    "efficient_track_anything/utils/__init__.py": "34bd8069c54764e7b8d73a78905dbe6467140a2f73170875128f6ca4d8cdd0aa",
    "efficient_track_anything/utils/misc.py": "3146ec42cb25d37d6682de628b9fee3b9e5abc6f4308db9d353d5fedeead5b83",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_record(path):
    require(path.is_file() and not path.is_symlink(), f"Expected a regular file: {path}")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return {"path": path.name, "sha256": digest.hexdigest(), "bytes": size}


def verify_file(path, expected):
    actual = file_record(path)
    require(actual["sha256"] == expected["sha256"], f"SHA-256 mismatch: {path}")
    if "bytes" in expected:
        require(actual["bytes"] == expected["bytes"], f"Byte count mismatch: {path}")
    return actual


def verify_upstream(directory, revision):
    require(revision == SOURCE_REVISION, "No reviewed source-file pins for this upstream revision.")
    for relative, digest in SOURCE_FILES.items():
        path = directory / relative
        verify_file(path, {"sha256": digest})
        # A second module with the same import name could bypass a verified .py file.
        if path.suffix == ".py":
            package = path.name == "__init__.py"
            module = Path(relative).parent if package else Path(relative).with_suffix("")
            search = path.parent.parent if package else path.parent
            found = importlib.machinery.PathFinder.find_spec(".".join(module.parts), [str(search)])
            require(found is not None and found.origin is not None
                    and Path(found.origin).resolve() == path.resolve(),
                    f"Unpinned module shadows upstream source: {path}")


def verify_output(directory):
    require(not directory.is_symlink(), "The output directory cannot be a symlink.")
    if directory.exists():
        require(directory.is_dir() and not any(directory.iterdir()),
                "Refusing to overwrite a nonempty output directory.")


def asset_records(manifest):
    require(manifest["schemaVersion"] == 1 and manifest["opset"] == 17,
            "Unsupported EfficientTAM export manifest.")
    require(set(manifest["graphs"]) == {"encoder", "decoder", "memoryAttention", "memoryEncoder"},
            "The manifest must name the four reviewed graphs.")
    require(set(manifest["constants"]) == {"memoryPosition", "temporalPositions"},
            "The manifest must name the two reviewed constants.")
    records = [*manifest["graphs"].values(), *manifest["constants"].values(), *manifest["notices"].values()]
    require(len(records) == 8 and len({record["path"] for record in records}) == 8,
            "The manifest must name exactly eight distinct model/notice files.")
    require(all(Path(record["path"]).name == record["path"] and record["path"] not in (".", "..")
                for record in records), "Asset filenames must not escape the output directory.")
    return records


def export_models(upstream, checkpoint, output, manifest):
    # Third-party imports and model construction occur only after the source,
    # checkpoint, dependencies, notices and untouched destination pass preflight.
    import numpy as np
    import onnx
    import torch
    import torch.nn.functional as F

    torch.set_num_threads(2)
    sys.path.insert(0, str(upstream))
    from efficient_track_anything.build_efficienttam import build_efficienttam_video_predictor
    from efficient_track_anything.modeling.sam.transformer import RoPEAttention

    predictor = build_efficienttam_video_predictor(
        manifest["upstream"]["configuration"], device="cpu", mode="eval",
        hydra_overrides_extra=["++model.compile_image_encoder=False"], apply_postprocessing=True,
    )
    loaded = torch.load(checkpoint, weights_only=True, map_location="cpu", mmap=True)
    require(isinstance(loaded, dict) and set(loaded) == {"model"}, "Unexpected checkpoint container.")
    state = loaded["model"]
    expected = predictor.state_dict()
    require(set(state) == set(expected), "Checkpoint state keys differ from the pinned constructor.")
    for name, tensor in state.items():
        require(isinstance(tensor, torch.Tensor) and tensor.shape == expected[name].shape
                and tensor.dtype == expected[name].dtype == torch.float32,
                f"Checkpoint tensor shape/dtype mismatch: {name}")
        require(bool(torch.isfinite(tensor).all()), f"Nonfinite checkpoint tensor: {name}")
    predictor.load_state_dict(state, strict=True)
    del expected, state, loaded

    class Encoder(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.encoder = model.image_encoder

        def forward(self, image):
            return self.encoder(image)["vision_features"]

    class Decoder(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            require(model.fixed_no_obj_ptr and not model.soft_no_obj_ptr,
                    "The export requires the fixed no-object pointer policy.")
            require(model.use_multimask_token_for_obj_ptr and model.pred_obj_scores,
                    "The export requires object scores and selected multimask pointers.")
            self.prompt = model.sam_prompt_encoder
            self.decoder = model.sam_mask_decoder
            self.pointer = model.obj_ptr_proj
            self.no_obj_ptr = model.no_obj_ptr
            self.no_mem_embed = model.no_mem_embed

        def forward(self, features, point_coords, point_labels, previous_logits,
                    has_previous, initial, multimask, native_size):
            features = torch.where(initial.reshape(1, 1, 1, 1), features + self.no_mem_embed.reshape(1, 256, 1, 1), features)
            sparse = self.prompt._embed_points(point_coords, point_labels, pad=True)
            prior = self.prompt._embed_masks(torch.clamp(previous_logits, -32.0, 32.0))
            absent = self.prompt.no_mask_embed.weight.reshape(1, 256, 1, 1).expand(1, 256, 32, 32)
            # A zero-valued prior is not the absent-prior embedding.
            dense = torch.where(has_previous.reshape(1, 1, 1, 1), prior, absent)
            masks, scores, tokens, object_score = self.decoder.predict_masks(
                image_embeddings=features, image_pe=self.prompt.get_dense_pe(),
                sparse_prompt_embeddings=sparse, dense_prompt_embeddings=dense,
                repeat_image=False, high_res_features=None)
            single_mask, single_score = self.decoder._dynamic_multimask_via_stability(masks, scores)
            best = torch.argmax(scores[:, 1:], dim=-1) + 1
            batch = torch.arange(scores.shape[0], device=scores.device)
            best_mask = masks[batch, best].unsqueeze(1)
            best_score = scores[batch, best].unsqueeze(1)
            selected_mask = torch.where(multimask.reshape(1, 1, 1, 1), best_mask, single_mask)
            selected_score = torch.where(multimask.reshape(1, 1), best_score, single_score)
            # The official stability fallback still uses token0; tracking multimask uses its selected token.
            token = torch.where(multimask.reshape(1, 1), tokens[batch, best], tokens[:, 0])
            present = object_score > 0
            selected_mask = torch.where(present[:, :, None, None], selected_mask, -1024.0)
            probability = present.float()
            pointer = probability * self.pointer(token) + (1 - probability) * self.no_obj_ptr
            native = F.interpolate(selected_mask, size=(native_size[0], native_size[1]), mode="bilinear", align_corners=False)
            return selected_mask, pointer, object_score, selected_score, native

    def real_rotary(values, cosine, sine):
        pairs = values.reshape(*values.shape[:-1], values.shape[-1] // 2, 2)
        repetitions = values.shape[-2] // cosine.shape[-2]
        cosine = cosine.unsqueeze(0).unsqueeze(0).unsqueeze(2).expand(1, 1, repetitions, -1, -1).flatten(2, 3)
        sine = sine.unsqueeze(0).unsqueeze(0).unsqueeze(2).expand(1, 1, repetitions, -1, -1).flatten(2, 3)
        real, imaginary = pairs[..., 0], pairs[..., 1]
        return torch.stack((real * cosine - imaginary * sine, real * sine + imaginary * cosine), dim=-1).flatten(-2)

    class RealRoPEAttention(RoPEAttention):
        def forward(self, q, k, v, num_k_exclude_rope=0):
            q = self._separate_heads(self.q_proj(q), self.num_heads)
            k = self._separate_heads(self.k_proj(k), self.num_heads)
            v = self._separate_heads(self.v_proj(v), self.num_heads)
            spatial_tokens = k.shape[-2] - num_k_exclude_rope
            q = real_rotary(q, self.rotary_cosine, self.rotary_sine)
            spatial = real_rotary(k[:, :, :spatial_tokens], self.rotary_cosine, self.rotary_sine)
            k = torch.cat((spatial, k[:, :, spatial_tokens:]), dim=2)
            out = F.scaled_dot_product_attention(q, k, v, dropout_p=0.0)
            return self.out_proj(self._recombine_heads(out))

    class MemoryAttention(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.attention = copy.deepcopy(model.memory_attention)
            cosine = self.attention.layers[0].self_attn.freqs_cis.real.contiguous()
            sine = self.attention.layers[0].self_attn.freqs_cis.imag.contiguous()
            for layer in self.attention.layers:
                for attention in (layer.self_attn, layer.cross_attn_image):
                    require(type(attention) is RoPEAttention and attention.num_heads == 1,
                            "The export requires the pinned single-head rotary attention.")
                    require(torch.equal(attention.freqs_cis.real, cosine) and torch.equal(attention.freqs_cis.imag, sine),
                            "Rotary constants differ between attention layers.")
                    attention.__class__ = RealRoPEAttention
                    attention.register_buffer("rotary_cosine", cosine)
                    attention.register_buffer("rotary_sine", sine)
            position = model.image_encoder.neck.position_encoding(torch.zeros(1, 256, 32, 32)).float()
            self.register_buffer("position", position.flatten(2).permute(2, 0, 1))

        def forward(self, features, memory, memory_position, pointer_tokens):
            current = features.flatten(2).permute(2, 0, 1)
            result = self.attention(curr=current, curr_pos=self.position, memory=memory,
                                    memory_pos=memory_position, num_obj_ptr_tokens=pointer_tokens)
            return result.permute(1, 2, 0).reshape(1, 256, 32, 32)

    class MemoryEncoder(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            require(model.no_obj_embed_spatial is None and model.binarize_mask_from_pts_for_mem_enc,
                    "The export requires point-conditioned memory without a spatial no-object embedding.")
            require(model.sigmoid_scale_for_mem_enc == 20 and model.sigmoid_bias_for_mem_enc == -10,
                    "Memory normalization differs from the reviewed model.")
            self.encoder = model.memory_encoder

        def forward(self, features, low_logits, from_points):
            high = F.interpolate(low_logits, size=(512, 512), mode="bilinear", align_corners=False)
            masks = torch.where(from_points.reshape(1, 1, 1, 1), (high > 0).float(), torch.sigmoid(high))
            return self.encoder(features, masks * 20.0 - 10.0, skip_mask_sigmoid=True)["vision_features"]

    def export(key, module, inputs, names, outputs, dynamic=None):
        path = output / manifest["graphs"][key]["path"]
        with path.open("xb") as target, torch.inference_mode():
            torch.onnx.export(module.eval(), inputs, target, input_names=names, output_names=outputs,
                              dynamic_axes=dynamic, opset_version=manifest["opset"], dynamo=False,
                              do_constant_folding=True, export_params=True)
        graph = onnx.load(path)
        onnx.checker.check_model(graph)
        require(graph.ir_version <= 11, "The graph IR exceeds the verified runtime contract.")
        require({item.domain: item.version for item in graph.opset_import} == {"": 17},
                "Unexpected custom domain or opset in export.")

    feature_zero = torch.zeros(1, 256, 32, 32)
    export("encoder", Encoder(predictor), (torch.zeros(1, 3, 512, 512),), ["image"], ["features"])
    # This generic tracing size preserves the reviewed export; native_size remains
    # a dynamic input, not a source geometry, crop, normalization or image policy.
    export("decoder", Decoder(predictor), (
        feature_zero, torch.tensor([[[0, 0], [1, 1]]], dtype=torch.float32),
        torch.tensor([[1, 1]], dtype=torch.int64), torch.zeros(1, 1, 128, 128),
        torch.tensor([False]), torch.tensor([True]), torch.tensor([False]),
        torch.tensor([182, 182], dtype=torch.int64),
    ), ["features", "point_coords", "point_labels", "previous_logits", "has_previous", "initial", "multimask", "native_size"],
        ["low_logits", "object_pointer", "object_score", "selected_iou", "native_logits"],
        {"point_coords": {1: "points"}, "point_labels": {1: "points"},
         "native_logits": {2: "native_height", 3: "native_width"}})
    export("memoryAttention", MemoryAttention(predictor), (
        feature_zero, torch.zeros(1028, 1, 64), torch.zeros(1028, 1, 64), torch.tensor(4, dtype=torch.int64),
    ), ["features", "memory", "memory_position", "pointer_tokens"], ["output"],
        {"memory": {0: "memory_tokens"}, "memory_position": {0: "memory_tokens"}})
    export("memoryEncoder", MemoryEncoder(predictor), (
        feature_zero, torch.zeros(1, 1, 128, 128), torch.tensor([True]),
    ), ["features", "low_logits", "from_points"], ["output"])

    # Spatial positions depend only on the model grid, never on image/mask values.
    # BF16 RNE history storage remains outside all graphs, at the controller boundary.
    with torch.inference_mode():
        constants = {
            "memoryPosition": predictor.memory_encoder.position_encoding(torch.zeros(1, 64, 32, 32)).float(),
            "temporalPositions": predictor.maskmem_tpos_enc.detach(),
        }
        for key, tensor in constants.items():
            record = manifest["constants"][key]
            require(list(tensor.shape) == record["shape"] and record["dtype"] == "float32-le",
                    f"Unexpected constant layout: {key}")
            with (output / record["path"]).open("xb") as target:
                target.write(np.asarray(tensor.cpu(), dtype="<f4").tobytes(order="C"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--upstream", type=Path, required=True, help="Pinned checkout or extracted upstream source archive")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New or empty destination; never overwritten")
    parser.add_argument("--notices", type=Path, help="Directory containing manifest-bound LICENSE and NOTICE")
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args(argv)
    verify_output(args.output)
    manifest = json.loads(MANIFEST.read_text())
    records = asset_records(manifest)
    upstream = args.upstream.resolve()
    verify_upstream(upstream, manifest["upstream"]["revision"])
    verify_file(args.checkpoint, manifest["upstream"]["checkpoint"])
    versions = {}
    for package in ("torch", "onnx"):
        versions[package] = importlib.metadata.version(package)
        require(versions[package] == manifest["exportProvenance"][package],
                f"{package} must be exactly {manifest['exportProvenance'][package]}, got {versions[package]}.")
    notices = args.notices or FRONTEND / "public" / manifest["directory"]
    for record in manifest["notices"].values():
        verify_file(notices / record["path"], record)
    report = {"model": manifest["id"], "manifestSha256": file_record(MANIFEST)["sha256"],
              "sourceRevision": SOURCE_REVISION, "checkpointSha256": manifest["upstream"]["checkpoint"]["sha256"],
              "versions": versions, "syntheticTracingOnly": True}
    if args.check_only:
        print(json.dumps({**report, "preflightOnly": True}))
        return
    verify_output(args.output)
    args.output.mkdir(parents=True, exist_ok=True)
    for record in manifest["notices"].values():
        with (args.output / record["path"]).open("xb") as target:
            target.write((notices / record["path"]).read_bytes())
    export_models(upstream, args.checkpoint, args.output, manifest)
    generated = [file_record(args.output / record["path"]) for record in records]
    matches = all(actual["sha256"] == expected["sha256"] and actual["bytes"] == expected["bytes"]
                  for actual, expected in zip(generated, records))
    print(json.dumps({**report, "exactManifestBytes": matches, "files": generated}, indent=2))
    require(matches, "Export bytes differ from the approved manifest. New files were preserved; separate parity review is required. Pins were not changed.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, importlib.metadata.PackageNotFoundError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
