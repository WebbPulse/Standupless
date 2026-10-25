"""Workspace change notices pushed to open clients over the WebSocket API.

The WebSocket function accepts and forgets connections, and the outbound stream
consumer, which already reads every issue, comment and planning write, tells each
connection that may read a change that it happened. A notice names what changed
and never carries it, so a client refetches through the HTTP API it already uses
and polling stays the fallback whenever a notice is missed.
"""
