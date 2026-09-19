"""The three consumers the `integrations` image runs under their own entrypoints.

Two read SQS, `github-events` and `webhook-dispatch`, and one reads the `issues`
and `comments` streams. All three are in this package because they write the
`github` table, so they carry this domain's bundle and its IAM grant.
"""
