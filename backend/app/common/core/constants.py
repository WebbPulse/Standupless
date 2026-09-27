"""Limits more than one domain has to agree on, named once.

A cap enforced in two places by two literals is a cap that drifts. These live in
`common` rather than in the domain that happens to reach them first, because the
same number bounds a value the data layer stores and a schema validates, and later
projects validate it again from a different domain.
"""

from __future__ import annotations

ISSUE_BODY_MAX_BYTES = 65536
"""The largest markdown body an issue may carry, in UTF-8 bytes.

Bytes rather than characters, because the limit exists to keep an item well under
DynamoDB's 400 KB ceiling and it is the encoded length that counts against it. The
M2 contract states the same number, and M3's comment bodies and M5's GitHub body
extraction both measure against this constant rather than restating it.
"""
