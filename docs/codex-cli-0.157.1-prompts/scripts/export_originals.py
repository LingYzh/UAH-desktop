#!/usr/bin/env python3
"""Export literal model instructions from the Codex 0.157.1 catalog.

Python 3.10+, standard library only. Reads local files or downloads official
public source; it does not invoke Codex, read credentials, or call a model.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

COMMIT = "36650394c5b38c2990ccf2a3457165ca3e9d9726"
CATALOG_PATH = "codex-rs/models-manager/models.json"
CATALOG_BLOB = "8fd2c078f857aa9e12ee2b74131e539d3ead520f"
RAW_URL = f"https://raw.githubusercontent.com/openai/codex/{COMMIT}/{CATALOG_PATH}"
PACK = Path(__file__).resolve().parents[1]


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def read_models(data: bytes) -> list[dict[str, Any]]:
    payload = json.loads(data.decode("utf-8-sig"))
    models = payload.get("models") if isinstance(payload, dict) else payload
    if not isinstance(models, list):
        raise ValueError("Expected a JSON object with a 'models' list, or a model list.")
    if not all(isinstance(m, dict) and isinstance(m.get("slug"), str) for m in models):
        raise ValueError("Every model must contain a string 'slug'.")
    return models


def object_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def resolved_role(model: dict[str, Any], role_name: str) -> tuple[str, str]:
    messages = object_or_empty(model.get("model_messages"))
    multi = object_or_empty(messages.get("multi_agent"))
    role = object_or_empty(multi.get("role"))
    value = role.get(role_name)
    # An explicitly empty string overrides the fallback in the Rust resolver.
    if isinstance(value, str):
        return value, "catalog"
    fallback = PACK / "original" / "bundled" / f"{role_name}-role.md"
    return fallback.read_bytes().decode("utf-8"), "bundled"


def source_bytes(args: argparse.Namespace) -> tuple[bytes, str, bool]:
    if args.catalog:
        p = args.catalog.expanduser().resolve()
        return p.read_bytes(), str(p), False
    if args.repo:
        p = args.repo.expanduser().resolve() / CATALOG_PATH
        data = p.read_bytes()
        if git_blob_sha(data) != CATALOG_BLOB:
            raise ValueError("This checkout's catalog differs from the pinned release. Use --catalog to intentionally export a different snapshot.")
        return data, str(p), True
    request = urllib.request.Request(RAW_URL, headers={"User-Agent": "codex-prompt-source-export/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("Catalog exceeds the 8 MiB download limit.")
    if git_blob_sha(data) != CATALOG_BLOB:
        raise ValueError("Downloaded bytes do not match the pinned Git blob. No export was written.")
    return data, RAW_URL, True


def safe_model_name(slug: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", slug):
        raise ValueError(f"Unsafe model slug for an output directory: {slug!r}")
    return slug


def model_files(model: dict[str, Any]) -> dict[str, bytes]:
    messages = object_or_empty(model.get("model_messages"))
    value = messages.get("instructions_template")
    # Mirrors render_model_instructions: literal text, no template expansion.
    # A missing template is empty here; this exporter does not invent a legacy base.
    base = value if isinstance(value, str) else ""
    root, root_source = resolved_role(model, "root")
    subagent, sub_source = resolved_role(model, "subagent")
    provenance = {
        "slug": model["slug"],
        "base_source": "model_messages.instructions_template",
        "base_missing": value is None,
        "role_sources": {"root": root_source, "subagent": sub_source},
        "base_resolution": "Literal string; no instructions_variables interpolation.",
        "assembly": "base + one LF + role; runtime fragments, tools, permissions, and mode selection are not included.",
    }
    text_files = {
        "base.md": base,
        "root-role.md": root,
        "subagent-role.md": subagent,
        "main.assembled.md": base + "\n" + root,
        "subagent.assembled.md": base + "\n" + subagent,
        "model-messages.json": json.dumps(messages, ensure_ascii=False, indent=4) + "\n",
        "provenance.json": json.dumps(provenance, ensure_ascii=False, indent=4) + "\n",
    }
    return {name: text.encode("utf-8") for name, text in text_files.items()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--catalog", type=Path, help="A local source/catalog/cache JSON containing a models list.")
    source.add_argument("--repo", type=Path, help="An existing checkout of the pinned Codex release.")
    parser.add_argument("--model", action="append", default=[], help="Exact model slug; repeat to select several. Default: export all.")
    parser.add_argument("--list", action="store_true", help="List model slugs without writing files.")
    parser.add_argument("--output", type=Path, default=Path("codex-original-export"))
    parser.add_argument("--overwrite", action="store_true", help="Permit replacement of files in the explicitly selected export directory.")
    parser.add_argument("--verify-pack", action="store_true", help="Compare supplied catalog text against the three bundled Astra source extracts; do not write.")
    args = parser.parse_args()
    try:
        data, source_name, verified = source_bytes(args)
        models = read_models(data)
        if args.list:
            print("\n".join(m["slug"] for m in models))
            return 0
        available = {m["slug"] for m in models}
        unknown = set(args.model) - available
        if unknown:
            raise ValueError("Model(s) absent from this snapshot: " + ", ".join(sorted(unknown)))
        if args.verify_pack:
            astra = next((m for m in models if m["slug"] == "gpt-6-astra"), None)
            if astra is None:
                raise ValueError("No gpt-6-astra entry in this source.")
            extracted = model_files(astra)
            pairs = {"base.md": "gpt-6-astra.base.md", "root-role.md": "gpt-6-astra.root-role.md", "subagent-role.md": "gpt-6-astra.subagent-role.md"}
            failures = []
            for short, packed in pairs.items():
                equal = extracted[short] == (PACK / "original" / packed).read_bytes()
                print(f"{'MATCH' if equal else 'DIFFERENT'} {packed}")
                if not equal:
                    failures.append(packed)
            print(f"Source Git blob verified: {verified}")
            return 1 if failures else 0
        selected = [m for m in models if not args.model or m["slug"] in args.model]
        output = args.output.expanduser().resolve()
        if output.exists() and not output.is_dir():
            raise ValueError(f"Output is not a directory: {output}")
        if output.exists() and any(output.iterdir()) and not args.overwrite:
            raise ValueError(f"Output is not empty: {output}; choose a new directory or use --overwrite.")
        # Prepare and validate all paths/content before writing.
        exports = [(safe_model_name(m["slug"]), model_files(m)) for m in selected]
        output.mkdir(parents=True, exist_ok=True)
        for slug, contents in exports:
            target = output / slug
            target.mkdir(parents=True, exist_ok=True)
            for name, payload in contents.items():
                (target / name).write_bytes(payload)
        manifest = {
            "source": source_name,
            "source_git_blob": git_blob_sha(data),
            "source_sha256": hashlib.sha256(data).hexdigest(),
            "pinned_release_bytes_verified": verified,
            "pinned_release": "rust-v0.157.1" if verified else None,
            "models": [slug for slug, _ in exports],
        }
        (output / "export-manifest.json").write_bytes((json.dumps(manifest, ensure_ascii=False, indent=4) + "\n").encode("utf-8"))
        print(f"Exported {len(exports)} model(s) to {output}")
        return 0
    except (OSError, ValueError, StopIteration, urllib.error.URLError) as exc:
        print(f"Export failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
