"""The Model Context Protocol server: transport, tools and the endpoint.

Kept as a package rather than one module because the three concerns are read
separately. `transport` is the JSON-RPC envelope, `tools` is what an agent may do,
and `endpoint` is where a bearer becomes an authorization context. A reviewer
asking "what can an agent reach" reads one file.
"""
