"""Middleware added inside the CORS and request id layers `create_app` installs."""

from app.common.api.middleware.rate_limiter import rate_limit_middleware

__all__ = ["rate_limit_middleware"]
