# syntax=docker/dockerfile:1.7

ARG BASE_IMAGE=432410731887.dkr.ecr.us-west-2.amazonaws.com/webbpulse/python-lambda-base@sha256:b5298b4b773ad6c9e311057cf5d43f37ceb98f0367347d714c6817f250a5cef7

FROM ${BASE_IMAGE} AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12.10@sha256:2bb3ebca0a796a155094a27773d290c4b074572e6107f171d88d086682fd2500 /uv /usr/local/bin/uv

USER root

WORKDIR /build

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    UV_PYTHON=/usr/local/bin/python3.13

COPY pyteam.toml uv.lock ./

RUN uv sync --locked --no-dev --no-install-team --no-install-package webbpulse

ARG DEPENDENCY_RESOLUTION=local

RUN --mount=type=secret,id=codeartifact_token,required=true \
    set -eu; \
    UV_INDEX_CODEARTIFACT_USERNAME=aws \
    UV_INDEX_CODEARTIFACT_PASSWORD="$(cat /run/secrets/codeartifact_token)" \
    uv lock --upgrade-package webbpulse; \
    UV_INDEX_CODEARTIFACT_USERNAME=aws \
    UV_INDEX_CODEARTIFACT_PASSWORD="$(cat /run/secrets/codeartifact_token)" \
    uv sync --frozen --no-dev --no-install-team; \
    /opt/venv/bin/python -c "import importlib.metadata as m; print('webbpulse', m.version('webbpulse'))"

RUN find /opt/venv -type d -name "__pycache__" -prune -exec rm -rf {} + \
    && find /opt/venv -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete

FROM ${BASE_IMAGE} AS runtime

USER root

COPY --from=builder /opt/venv /opt/venv
COPY app/ /var/task/app/

ARG DOMAIN
RUN set -eu; \
    test -n "${DOMAIN}" || { \
        echo "DOMAIN build arg is required, naming one domain in app/common/composition/domains.py:" >&2; \
        echo "  docker buildx build --build-arg DOMAIN=workspaces ..." >&2; \
        exit 1; \
    }; \
    package="$(echo "${DOMAIN}" | tr '-' '_')"; \
    test -f "/var/task/app/domains/${package}/entrypoint.py" || { \
        echo "DOMAIN=${DOMAIN} maps to app/domains/${package}/entrypoint.py, which is not in the image." >&2; \
        exit 1; \
    }; \
    echo "app.domains.${package}.entrypoint" > /etc/standupless-entrypoint

ENV DOMAIN=${DOMAIN} \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONPATH=/var/task \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AWS_LWA_PORT=8080 \
    PORT=8080 \
    AWS_LWA_ASYNC_INIT=true \
    AWS_LWA_READINESS_CHECK_PATH=/health \
    AWS_LWA_READINESS_CHECK_PROTOCOL=http

WORKDIR /var/task

USER app

CMD ["sh", "-c", "exec python -m \"$(cat /etc/standupless-entrypoint)\""]
