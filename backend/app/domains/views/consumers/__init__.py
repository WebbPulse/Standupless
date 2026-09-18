"""The two stream consumers the `views` image runs under their own entrypoints.

Both are in this package rather than in a function of their own because they write
`inbox` and `search_index`, which are this domain's tables, so they carry the same
bundle and the same IAM grant the routes do.
"""
