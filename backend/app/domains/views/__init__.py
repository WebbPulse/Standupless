"""The `views` domain: the board, saved views, search and the inbox.

Every surface here reads issues and never writes one, which is what keeps the
board and the search projection from becoming a second write path onto an issue.
The two stream consumers ship in this same image under their own entrypoints.
"""
