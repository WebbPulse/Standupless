"""Serve a minimal in-memory S3 for a local stack, so imports run end to end without AWS.

A local stack has DynamoDB Local but no object store, and an import keeps its job,
its upload and a Linear import's sealed key as objects. This answers the handful of
path-style calls the import code makes, `PutObject`, `GetObject`, `HeadObject`,
`DeleteObject` and `ListObjectsV2`, for any bucket name, keeping everything in
memory until the process exits. It is a test stand-in, never a store.

The backend reaches it through `AWS_ENDPOINT_URL_S3=http://127.0.0.1:9100`, and an
IP endpoint is what makes botocore address buckets by path. Payload checksums are
switched off with `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`, and an
`aws-chunked` body is still decoded in case a client sends one.

Usage, from backend/:
    python scripts/local_s3.py [port]
"""

from __future__ import annotations

import hashlib
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import parse_qs, unquote, urlsplit
from xml.sax.saxutils import escape

PORT = 9100

OBJECTS: dict[tuple[str, str], tuple[bytes, str, datetime]] = {}

LOCK = threading.Lock()


def decode_chunked(body: bytes) -> bytes:
    """The payload of an `aws-chunked` body, dropping chunk signatures and trailers."""
    out = bytearray()
    rest = body
    while rest:
        line, _, rest = rest.partition(b"\r\n")
        size = int(line.split(b";", 1)[0] or b"0", 16)
        if size == 0:
            break
        out += rest[:size]
        rest = rest[size + 2 :]
    return bytes(out)


class Handler(BaseHTTPRequestHandler):
    """One S3 request, path style: `/<bucket>/<key>` or `/<bucket>?list-type=2`."""

    def log_message(self, format: str, *args: object) -> None:
        """Keep request lines out of the log, they carry nothing worth reading."""

    def _target(self) -> tuple[str, str, dict[str, list[str]]]:
        """The bucket, the object key and the query of this request."""
        parts = urlsplit(self.path)
        path = unquote(parts.path).lstrip("/")
        bucket, _, key = path.partition("/")
        return bucket, key, parse_qs(parts.query)

    def _send(self, status: int, body: bytes = b"", content_type: str = "application/xml", **headers: str) -> None:
        """Answer with a status, a body and any extra headers."""
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers.items():
            self.send_header(name.replace("_", "-"), value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _missing(self, key: str) -> None:
        """Answer the `NoSuchKey` error botocore raises as a `ClientError`."""
        body = f"<Error><Code>NoSuchKey</Code><Message>missing</Message><Key>{escape(key)}</Key></Error>"
        self._send(404, body.encode())

    def _found(self, bucket: str, key: str) -> Optional[tuple[bytes, str, datetime]]:
        """The stored object, or `None`."""
        with LOCK:
            return OBJECTS.get((bucket, key))

    def do_PUT(self) -> None:
        """Store an object, or accept a bucket creation."""
        bucket, key, _ = self._target()
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if "aws-chunked" in (self.headers.get("Content-Encoding") or "") or (
            self.headers.get("x-amz-content-sha256") or ""
        ).startswith("STREAMING-"):
            body = decode_chunked(body)
        if key:
            with LOCK:
                OBJECTS[(bucket, key)] = (
                    body,
                    self.headers.get("Content-Type") or "application/octet-stream",
                    datetime.now(timezone.utc),
                )
        self._send(200, b"", ETag=f'"{hashlib.md5(body, usedforsecurity=False).hexdigest()}"')

    def do_GET(self) -> None:
        """Read an object, or list a bucket."""
        bucket, key, query = self._target()
        if not key:
            self._list(bucket, query)
            return
        found = self._found(bucket, key)
        if found is None:
            self._missing(key)
            return
        body, content_type, _ = found
        self._send(200, body, content_type, ETag=f'"{hashlib.md5(body, usedforsecurity=False).hexdigest()}"')

    def do_HEAD(self) -> None:
        """Answer whether an object exists."""
        bucket, key, _ = self._target()
        found = self._found(bucket, key) if key else (b"", "application/xml", datetime.now(timezone.utc))
        if found is None:
            self._send(404)
            return
        self._send(200, found[0], found[1])

    def do_DELETE(self) -> None:
        """Delete an object, answering 204 whether or not it existed, as S3 does."""
        bucket, key, _ = self._target()
        with LOCK:
            OBJECTS.pop((bucket, key), None)
        self._send(204)

    def _list(self, bucket: str, query: dict[str, list[str]]) -> None:
        """Answer `ListObjectsV2` for one prefix in a single page."""
        prefix = (query.get("prefix") or [""])[0]
        with LOCK:
            rows = sorted((key, value) for (name, key), value in OBJECTS.items() if name == bucket)
        entries = "".join(
            f"<Contents><Key>{escape(key)}</Key>"
            f"<LastModified>{stamp.strftime('%Y-%m-%dT%H:%M:%S.000Z')}</LastModified>"
            f"<Size>{len(body)}</Size><StorageClass>STANDARD</StorageClass></Contents>"
            for key, (body, _, stamp) in rows
            if key.startswith(prefix)
        )
        count = entries.count("<Contents>")
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            f"<Name>{escape(bucket)}</Name><Prefix>{escape(prefix)}</Prefix><KeyCount>{count}</KeyCount>"
            f"<MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>{entries}</ListBucketResult>"
        )
        self._send(200, body.encode())


def main() -> None:
    """Serve until the process is stopped."""
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"local S3 on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
