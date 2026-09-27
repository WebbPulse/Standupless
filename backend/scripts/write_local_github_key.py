"""Generate a throwaway RSA key and export it as `GITHUB_PRIVATE_KEY` for a local stack.

`settings.github_configured` is false without a private key, so every GitHub route
answers 503 and the `webbpulse.e2e` reachability group, which asserts that no route
answers 5xx, fails on all of them. The key is only ever used to sign an App JWT that
no GitHub API call is made with on a local stack, so a fresh one per run is enough
and nothing has to be shared or stored.

Generated rather than written into the workflow file, where a PEM would read like a
real credential. It is appended to `GITHUB_ENV` when running under GitHub Actions, so
the backend started by the next step picks it up; otherwise it is printed as a shell
export for a person to eval.

Local only. It refuses to run without `DYNAMODB_ENDPOINT_URL`, the same guard the
other local bootstrap scripts carry.

Usage, from backend/:
    DYNAMODB_ENDPOINT_URL=http://localhost:8001 python scripts/write_local_github_key.py
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.common.core.config import settings  # noqa: E402

VARIABLE = "GITHUB_PRIVATE_KEY"


def generate_key() -> str:
    """A fresh 2048 bit RSA private key in PKCS#8 PEM form, which is what PyJWT reads."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()


def export(pem: str) -> None:
    """Publish the key to the steps that follow, or to the caller's shell.

    A PEM spans lines, so `GITHUB_ENV` needs the heredoc form with a delimiter that
    cannot appear in the value.
    """
    github_env = os.environ.get("GITHUB_ENV", "")
    if not github_env:
        print(f"export {VARIABLE}='{pem}'")
        return
    delimiter = f"ghadelim_{uuid.uuid4().hex}"
    with open(github_env, "a", encoding="utf-8") as handle:
        handle.write(f"{VARIABLE}<<{delimiter}\n{pem}\n{delimiter}\n")
    print(f"Exported {VARIABLE} for the local stack.")


def main() -> int:
    """Generate and export the key, or return 1 when this is not a local stack."""
    if not settings.DYNAMODB_ENDPOINT_URL:
        print(
            "DYNAMODB_ENDPOINT_URL is not set; refusing to plant a GitHub key outside a local stack.",
            file=sys.stderr,
        )
        return 1
    export(generate_key())
    return 0


if __name__ == "__main__":
    sys.exit(main())
