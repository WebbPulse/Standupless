#!/usr/bin/env bash
set -euo pipefail

ZIP="$1"
SMOKE_SECONDS="${SMOKE_SECONDS:-20}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ditto -x -k "$ZIP" "$WORK"
APP="$(find "$WORK" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$APP" ]; then
  echo "::error::no .app inside ${ZIP}"
  exit 1
fi
NAME="$(basename "$APP" .app)"
BIN="${APP}/Contents/MacOS/${NAME}"

echo "Checking the signature of ${APP}"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign --display --verbose=2 "$APP" 2>&1 | grep -E '^(Identifier|Format|Signature|TeamIdentifier)=' || true
lipo -info "$BIN"

smoke() {
  local label="$1"
  shift
  local log="${WORK}/launch-${label}.log"
  echo "Launching the ${label} slice for ${SMOKE_SECONDS}s"
  "$@" "$BIN" >"$log" 2>&1 &
  local pid=$!
  local waited=0
  while [ "$waited" -lt "$SMOKE_SECONDS" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      local status=0
      wait "$pid" || status=$?
      cat "$log"
      echo "::error::the ${label} slice exited after ${waited}s with status ${status}"
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  pkill -f "${APP}/Contents" 2>/dev/null || true
  echo "The ${label} slice stayed up for ${SMOKE_SECONDS}s."
}

smoke "$(uname -m)" env
if [ "$(uname -m)" = "arm64" ] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  smoke x86_64 arch -x86_64
else
  echo "Rosetta is not available, so the x86_64 slice is not launched."
fi
