#!/usr/bin/env python3
"""Render uppercase {{HOST_PLACEHOLDERS}} once. Python 3.10+, no dependencies."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SLOT = re.compile(r"\{\{([A-Z][A-Z0-9_]*)\}\}")


def render(template: str, bindings: dict[str, str]) -> str:
    required = set(SLOT.findall(template))
    invalid = [key for key in sorted(required) if key not in bindings or not isinstance(bindings[key], str) or not bindings[key].strip()]
    if invalid:
        raise ValueError("Missing, empty, or non-string binding(s): " + ", ".join(invalid))
    # One pass only: tool schemas or inserted task text are never re-templated.
    return SLOT.sub(lambda match: bindings[match.group(1)], template)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path)
    parser.add_argument("bindings", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    try:
        template = args.template.read_text(encoding="utf-8-sig")
        bindings = json.loads(args.bindings.read_text(encoding="utf-8-sig"))
        if not isinstance(bindings, dict):
            raise ValueError("Bindings must be a JSON object.")
        result = render(template, bindings)
        if args.output.exists() and not args.overwrite:
            raise ValueError("Output already exists; use another path or --overwrite.")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(result.encode("utf-8"))
        print(f"Rendered {args.output}")
        return 0
    except (OSError, ValueError) as exc:
        print(f"Render failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
