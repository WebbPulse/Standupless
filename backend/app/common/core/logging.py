"""Log configuration on top of the shared package's JSON formatter.

Deployed processes get the shared JSON lines. Handlers move to stderr either way,
since some commands write data on stdout.
"""

import logging
import sys

from webbpulse.log_context import attach_log_context
from webbpulse.logging import configure_logging as _configure_json_logging


def _redirect_handlers_to_stderr(root: logging.Logger) -> None:
    """Move the root's stdout stream handlers onto stderr, keeping the formatter.

    A command that writes data to stdout would otherwise be corrupted by one
    interleaved log line. Lambda captures both streams alike.
    """
    for handler in root.handlers:
        if isinstance(handler, logging.StreamHandler) and getattr(handler, "stream", None) is sys.stdout:
            handler.setStream(sys.stderr)


def configure_app_logging(level: str = "INFO", service: str | None = None, environment: str | None = None) -> None:
    """Configure the root logger with the shared JSON formatter.

    Idempotent, so calling it from both an import and a `main()` leaves one
    handler rather than duplicating every line.
    """
    _configure_json_logging(level=level, service=service, environment=environment)
    root = logging.getLogger()
    _redirect_handlers_to_stderr(root)
    attach_log_context(root)


logger = logging.getLogger(__name__)


def get_logger() -> logging.Logger:
    """This module's logger."""
    return logger
