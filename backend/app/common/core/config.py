"""Standupless's settings, layered on `webbpulse.config.BaseServiceSettings`.

`case_sensitive` is overridden because `SECRET_KEY` aliases the `SECRET_KEY_SETTING`
field and would otherwise collide with it. `_resolve_secret` resolves one at a time.
"""

import os
from functools import lru_cache
from urllib.parse import urlparse

from pydantic import Field, model_validator
from pydantic_settings import SettingsConfigDict
from webbpulse.config import BaseServiceSettings
from webbpulse.security import app_secrets

SECRET_FIELDS = (
    "SECRET_KEY",
    "GITHUB_APP_ID",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "WEBHOOK_SIGNING_KEY",
)
"""Every key of the one JSON app secret.

The five GitHub values are external: the App is created by hand in the GitHub org
and its credentials are placed in the secret out of band, so Terraform declares the
keys and never their values. `WEBHOOK_SIGNING_KEY` is the master the outbound
endpoint secrets are derived from, which is what keeps a customer's signing key out
of the `github` table.
"""

PRODUCTION_HOST = "standupless.dev"

STAGING_HOST = "staging.standupless.dev"


class Settings(BaseServiceSettings):
    """Every setting Standupless reads, from the environment or a `.env` file."""

    API_STR: str = "/api"
    PROJECT_NAME: str = "Standupless"
    DEBUG: bool = False

    SECRET_KEY_SETTING: str = Field(
        default="",
        alias="SECRET_KEY",
        description="Application secret for the few tokens the product signs itself. Resolved on access.",
    )

    FRONTEND_URL: str = Field(
        default="",
        description=(
            "Public origin of the user-facing SPA. Empty = per-environment default derived from APP_ENVIRONMENT."
        ),
    )

    API_URL: str = Field(
        default="",
        description="Public origin of this backend API. Empty = per-environment default derived from APP_ENVIRONMENT.",
    )

    @property
    def frontend_base_url(self) -> str:
        """Public origin of the SPA, for absolute links in email.

        From `FRONTEND_URL`, else derived from `APP_ENVIRONMENT` rather than the request
        host, since backend and frontend sit on separate domains. No trailing slash.
        """
        if self.FRONTEND_URL:
            return self.FRONTEND_URL.strip().rstrip("/")
        if not self.is_production:
            return "http://localhost:4000"
        if self.APP_ENVIRONMENT.lower() == "staging":
            return f"https://{STAGING_HOST}"
        return f"https://{PRODUCTION_HOST}"

    @property
    def api_base_url(self) -> str:
        """Public origin of this API, for links that point back at it.

        From `API_URL`, else derived from `APP_ENVIRONMENT` so staging never mails
        production links. No trailing slash.
        """
        if self.API_URL:
            return self.API_URL.strip().rstrip("/")
        if not self.is_production:
            return f"http://localhost:{self.PORT}"
        if self.APP_ENVIRONMENT.lower() == "staging":
            return f"https://api.{STAGING_HOST}"
        return f"https://api.{PRODUCTION_HOST}"

    @property
    def webauthn_rp_id(self) -> str:
        """The WebAuthn relying party id: the SPA's hostname."""
        hostname = urlparse(self.frontend_base_url).hostname
        return hostname or "localhost"

    @property
    def webauthn_rp_name(self) -> str:
        """The WebAuthn relying party display name shown in the authenticator prompt."""
        return self.PROJECT_NAME

    ALLOWED_ORIGINS: str = Field(
        default=(
            "http://localhost,http://localhost:3000,http://localhost:4000,"
            f"https://{PRODUCTION_HOST},"
            f"https://www.{PRODUCTION_HOST},"
            f"https://api.{PRODUCTION_HOST},"
            f"https://{STAGING_HOST},"
            f"https://api.{STAGING_HOST}"
        ),
        description="Comma-separated list of allowed origins",
    )

    @property
    def allowed_origins_list(self) -> list[str]:
        """Every origin CORS admits.

        The literal `"null"` origin is excluded on purpose, since sandboxed iframes and
        `file://` pages send it and would otherwise get credentialed access.
        """
        if not self.ALLOWED_ORIGINS:
            return []
        return [origin.strip() for origin in self.ALLOWED_ORIGINS.split(",") if origin.strip()]

    PORT: int = 8000
    APP_ENVIRONMENT: str = "development"
    RUN_STARTUP_TASKS: bool = Field(
        default=True,
        description="Run lifespan startup work. Lambda sets this false.",
    )

    IDENTITY_ISSUER: str = Field(
        default="",
        description=(
            "The identity issuer, as terraform/identity.tf renders it. Empty means the "
            "webbpulse.identity router does not mount, which is the state of a local run "
            "and of the test suite."
        ),
    )

    IDENTITY_AUDIENCE: str = Field(
        default="",
        description=(
            "The aud claim every access token carries, as terraform/identity.tf renders it. "
            "Read with IDENTITY_ISSUER by the in-process JWKS verifier on a domain function."
        ),
    )

    IDENTITY_JWKS_URL: str = Field(
        default="",
        description=(
            "Override for the JWKS URL the in-process verifier fetches. Empty derives it "
            "from IDENTITY_ISSUER as <issuer>/.well-known/jwks.json."
        ),
    )

    IDENTITY_MCP_RESOURCE_URL: str = Field(
        default="",
        description=(
            "The RFC 8707 resource an MCP access token is bound to, as terraform/identity.tf "
            "renders it. It is the aud such a token carries, which is the MCP endpoint itself "
            "rather than IDENTITY_AUDIENCE, so the integrations function reads it to verify a "
            "bearer in process. Empty means no MCP token verifies here."
        ),
    )

    DYNAMODB_TABLE_PREFIX: str = Field(
        default="",
        description="Prefix for every DynamoDB table name. Empty = standupless-<APP_ENVIRONMENT>.",
    )
    DYNAMODB_ENDPOINT_URL: str = Field(
        default="",
        description="DynamoDB endpoint override (DynamoDB Local). Empty = native AWS endpoint.",
    )

    @property
    def dynamodb_table_prefix(self) -> str:
        """The DynamoDB table name prefix, defaulting to `standupless-<environment>`."""
        return self.DYNAMODB_TABLE_PREFIX or f"standupless-{self.APP_ENVIRONMENT.lower()}"

    @property
    def is_production(self) -> bool:
        """True outside debug mode and the development environment."""
        return not self.DEBUG and self.APP_ENVIRONMENT.lower() != "development"

    EMAIL_ENABLED: bool = Field(
        default=False,
        description="Enable email sending via SES. When false, email calls are silently skipped.",
    )
    EMAIL_FROM: str = Field(default="")

    ENABLE_RATE_LIMITING: bool = True
    ENABLE_SHARED_RATE_LIMITING: bool = True
    RATE_LIMIT_REQUESTS_PER_MINUTE: int = 60
    RATE_LIMIT_GET_REQUESTS_PER_MINUTE: int = 200
    RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE: int = 10
    RATE_LIMITS_TABLE: str = ""

    GITHUB_APP_SLUG: str = Field(
        default="",
        description=(
            "The GitHub App's slug, which is the only part of its install URL that "
            "is not a constant. Empty means the install flow reports that this "
            "environment has no App rather than sending anyone to a guessed URL."
        ),
    )

    GITHUB_EVENTS_QUEUE_URL: str = Field(
        default="",
        description=(
            "Queue the webhook route hands a verified delivery to. Empty means the "
            "route refuses rather than dropping deliveries on the floor."
        ),
    )

    WEBHOOK_DISPATCH_QUEUE_URL: str = Field(
        default="",
        description=(
            "Queue carrying GitHub write-back and outbound webhook jobs. Empty means "
            "a producer raises rather than silently not delivering."
        ),
    )

    ATTACHMENTS_BUCKET: str = Field(
        default="",
        description=(
            "Bucket the discussion domain presigns attachment uploads and downloads "
            "against. Empty means uploads are refused rather than signed against a "
            "guessed name, so a function deployed without the grant fails closed."
        ),
    )

    AWS_REGION: str = Field(
        default="auto",
        description="AWS region for the AWS clients. Also accepts AWS_DEFAULT_REGION.",
    )
    AWS_DEFAULT_REGION: str = Field(
        default="",
        description="Alternative name for region (maps to AWS_REGION if AWS_REGION is not set)",
    )

    APP_SECRETS_ARN: str = Field(
        default="",
        description=(
            "ARN of the one JSON secret holding SECRET_FIELDS. Empty = secrets come "
            "from the environment only and no Secrets Manager call is ever made."
        ),
    )

    @model_validator(mode="after")
    def validate_and_normalize_settings(self) -> "Settings":
        """Normalise the aliased region variable names after validation.

        Deliberately never reads `SECRET_KEY`: doing so would put a Secrets Manager call
        on the import path. `require_secrets` checks it at the point of use instead.
        """
        if not self.AWS_REGION or self.AWS_REGION == "auto":
            if self.AWS_DEFAULT_REGION:
                object.__setattr__(self, "AWS_REGION", self.AWS_DEFAULT_REGION)
            else:
                object.__setattr__(self, "AWS_REGION", "auto")

        self._mirror_base_fields()
        return self

    _ENVIRONMENT_ALIASES = {
        "development": "local",
        "dev": "local",
        "local": "local",
        "test": "test",
        "testing": "test",
        "staging": "staging",
        "production": "production",
        "prod": "production",
    }

    def _mirror_base_fields(self) -> None:
        """Fill the base's lower case fields from Standupless's uppercase spellings.

        A pydantic field cannot be shadowed by a property, so the two are reconciled
        here rather than derived, and anything reading through the base sees the same values.
        """
        object.__setattr__(
            self,
            "environment",
            self._ENVIRONMENT_ALIASES.get(self.APP_ENVIRONMENT.strip().lower(), "local"),
        )
        object.__setattr__(self, "service_name", self.PROJECT_NAME)
        object.__setattr__(self, "app_secrets_arn", self.APP_SECRETS_ARN)
        object.__setattr__(self, "cors_allow_origins", self.allowed_origins_list)
        object.__setattr__(self, "cors_allow_credentials", True)

    def _resolve_secret(self, name: str) -> str:
        """Resolve one secret, preferring the environment over the `APP_SECRETS_ARN` blob.

        Returns an empty string when neither supplies it.
        """
        from_env = os.environ.get(name, "") or getattr(self, f"{name}_SETTING", "")
        if from_env:
            return from_env
        arn = os.environ.get("APP_SECRETS_ARN", "") or self.APP_SECRETS_ARN
        if not arn:
            return ""
        return app_secrets(arn).get(name, "")

    @property
    def SECRET_KEY(self) -> str:
        """The application secret, resolved on access."""
        return self._resolve_secret("SECRET_KEY")

    @property
    def GITHUB_APP_ID(self) -> str:
        """The GitHub App's numeric id, resolved on access."""
        return self._resolve_secret("GITHUB_APP_ID")

    @property
    def GITHUB_CLIENT_ID(self) -> str:
        """The GitHub App's OAuth client id, resolved on access."""
        return self._resolve_secret("GITHUB_CLIENT_ID")

    @property
    def GITHUB_CLIENT_SECRET(self) -> str:
        """The GitHub App's OAuth client secret, resolved on access."""
        return self._resolve_secret("GITHUB_CLIENT_SECRET")

    @property
    def GITHUB_PRIVATE_KEY(self) -> str:
        """The GitHub App's private key PEM, resolved on access.

        Signs the short lived App JWT an installation token is minted with. Never
        logged and never stored anywhere but the secret.
        """
        return self._resolve_secret("GITHUB_PRIVATE_KEY")

    @property
    def GITHUB_WEBHOOK_SECRET(self) -> str:
        """The secret GitHub signs its deliveries with, resolved on access."""
        return self._resolve_secret("GITHUB_WEBHOOK_SECRET")

    @property
    def WEBHOOK_SIGNING_KEY(self) -> str:
        """The master every outbound endpoint's signing key is derived from."""
        return self._resolve_secret("WEBHOOK_SIGNING_KEY")

    @property
    def github_configured(self) -> bool:
        """Whether this environment has a GitHub App to install.

        Checked before the install flow does anything, so an environment whose secret
        has not been filled answers "not configured" rather than a 500 from a token
        mint against an empty key.
        """
        return bool(self.GITHUB_APP_SLUG and self.GITHUB_APP_ID and self.GITHUB_PRIVATE_KEY)

    def require_secrets(self, *names: str) -> None:
        """Raise unless every named secret resolves to a non-empty value.

        Called at the point of use rather than at import, so a domain that never
        signs anything needs neither the secret nor the IAM grant.
        """
        unknown = [name for name in names if name not in SECRET_FIELDS]
        if unknown:
            raise ValueError(f"Unknown secret(s): {', '.join(sorted(unknown))}")
        missing = [name for name in names if not self._resolve_secret(name)]
        if missing:
            raise ValueError(
                "Missing required secret(s) (set them as environment variables or "
                f"as keys of the APP_SECRETS_ARN secret): {', '.join(missing)}"
            )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
        populate_by_name=True,
    )


@lru_cache()
def get_settings() -> Settings:
    """The process-wide `Settings`, cached so the env is parsed once.

    Tests may override it before the first call.
    """
    return Settings()


settings = get_settings()
