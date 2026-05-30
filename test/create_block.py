#!/usr/bin/env python3
"""Validate that every block JSON path resolves in the installed PyTorch."""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BLOCKS_DIR = REPO_ROOT / "blocks"

sys.path.insert(0, str(REPO_ROOT))
from scripts.create_block import build_block_spec  # noqa: E402


def main() -> int:
    if not BLOCKS_DIR.is_dir():
        raise FileNotFoundError(f"blocks folder not found: {BLOCKS_DIR}")

    for json_path in sorted(BLOCKS_DIR.rglob("*.json")):
        with json_path.open(encoding="utf-8") as f:
            torch_path = json.load(f)["path"]
        try:
            build_block_spec(torch_path)
            print(json_path.relative_to(REPO_ROOT))
        except Exception as e:
            print("================================================")
            print(f"error: {json_path.relative_to(REPO_ROOT)}: {e}")
            print("================================================")

    print(f"ok: {sum(1 for _ in BLOCKS_DIR.rglob('*.json'))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
