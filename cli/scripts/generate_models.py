"""Regenerate the typed response and request shapes from the published OpenAPI document.

Run `uv run python scripts/generate_models.py` after `backend/openapi.json` changes, and
`--check` in CI to fail when the committed module has drifted from the document.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCUMENT = ROOT.parent / "backend" / "openapi.json"
TARGET = ROOT / "src" / "standupless_cli" / "_generated" / "models.py"
HEADER = '"""Typed shapes generated from backend/openapi.json by datamodel-codegen. Do not edit."""'


def generate(output: Path) -> None:
    """Write the TypedDict module for the document to `output`."""
    subprocess.run(
        [
            sys.executable,
            "-m",
            "datamodel_code_generator",
            "--input",
            str(DOCUMENT),
            "--input-file-type",
            "openapi",
            "--output-model-type",
            "typing.TypedDict",
            "--target-python-version",
            "3.11",
            "--use-standard-collections",
            "--use-union-operator",
            "--disable-timestamp",
            "--formatters",
            "ruff-format",
            "--custom-file-header",
            HEADER,
            "--output",
            str(output),
        ],
        check=True,
    )


def main() -> int:
    """Regenerate in place, or with `--check` compare a fresh generation to the committed file."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail when the committed module is stale")
    args = parser.parse_args()
    if not args.check:
        generate(TARGET)
        return 0
    with tempfile.TemporaryDirectory(dir=ROOT) as scratch:
        fresh = Path(scratch) / "models.py"
        generate(fresh)
        if fresh.read_text() != TARGET.read_text():
            print(
                "src/standupless_cli/_generated/models.py is stale against backend/openapi.json. "
                "Run `uv run python scripts/generate_models.py` in cli/ and commit the result.",
                file=sys.stderr,
            )
            return 1
    print("Generated models match backend/openapi.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
