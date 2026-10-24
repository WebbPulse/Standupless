"""Create the S3 bucket and SES identity a local stack needs on its AWS emulator.

The PR e2e run starts floci next to DynamoDB Local and points the backend at it
through `AWS_ENDPOINT_URL_S3` and `AWS_ENDPOINT_URL_SESV2`. This creates the
versioned `ATTACHMENTS_BUCKET` that imports, exports, attachments and icons share,
and verifies the domain of `IDENTITY_EMAIL_FROM` so sends from it are accepted.
Both steps are idempotent, so a rerun against the same emulator is harmless.

Usage, from backend/:
    AWS_ENDPOINT_URL_S3=http://127.0.0.1:4566 AWS_ENDPOINT_URL_SESV2=http://127.0.0.1:4566 \\
        python scripts/create_local_aws_resources.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import boto3  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

from app.common.core.config import settings  # noqa: E402


def region() -> str:
    """The region the backend signs for, which is where the emulator keeps its resources."""
    return settings.AWS_REGION or os.environ.get("AWS_DEFAULT_REGION") or "us-west-2"


def create_bucket(name: str) -> None:
    """Create the bucket with versioning on, as Terraform provisions it."""
    client = boto3.client("s3", region_name=region())
    request: dict[str, Any] = {"Bucket": name}
    if region() != "us-east-1":
        request["CreateBucketConfiguration"] = {"LocationConstraint": region()}
    try:
        client.create_bucket(**request)
        print(f"created bucket {name}")
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
            raise
        print(f"exists  bucket {name}")
    client.put_bucket_versioning(Bucket=name, VersioningConfiguration={"Status": "Enabled"})


def verify_sender(address: str) -> None:
    """Verify the domain of the from address, so the emulator accepts sends from it."""
    domain = address.rsplit("@", 1)[-1].strip(" >")
    client = boto3.client("sesv2", region_name=region())
    try:
        client.create_email_identity(EmailIdentity=domain)
        print(f"created email identity {domain}")
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") != "AlreadyExistsException":
            raise
        print(f"exists  email identity {domain}")


def main() -> None:
    """Create whatever the environment names, skipping a resource it leaves unset."""
    bucket = settings.ATTACHMENTS_BUCKET.strip()
    if bucket:
        create_bucket(bucket)
    sender = os.environ.get("IDENTITY_EMAIL_FROM", "").strip() or settings.EMAIL_FROM.strip()
    if sender:
        verify_sender(sender)


if __name__ == "__main__":
    main()
