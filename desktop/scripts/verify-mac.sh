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

REPORTS="${HOME}/Library/Logs/DiagnosticReports"

stop_app() {
  pkill -9 -f "${APP}/Contents" 2>/dev/null || true
}

smoke() {
  local label="$1"
  shift
  local log="${WORK}/launch-${label}.log"
  local marker="${WORK}/marker-${label}"
  touch "$marker"
  echo "Launching the ${label} slice for ${SMOKE_SECONDS}s"
  "$@" "$BIN" </dev/null >"$log" 2>&1 &
  local pid=$!
  sleep "$SMOKE_SECONDS"
  local alive=0
  kill -0 "$pid" 2>/dev/null && alive=1
  kill -9 "$pid" 2>/dev/null || true
  stop_app
  local crashes
  crashes="$(find "$REPORTS" -maxdepth 1 -newer "$marker" -name "${NAME}*" 2>/dev/null || true)"
  if [ "$alive" -ne 1 ] || [ -n "$crashes" ]; then
    echo "--- launch output ---"
    cat "$log"
    while IFS= read -r report; do
      [ -n "$report" ] || continue
      echo "--- ${report} ---"
      head -c 6000 "$report"
      echo
    done <<<"$crashes"
    echo "::error::the ${label} slice did not stay up for ${SMOKE_SECONDS}s"
    exit 1
  fi
  echo "The ${label} slice stayed up for ${SMOKE_SECONDS}s."
}

trap 'stop_app; rm -rf "$WORK"' EXIT

smoke "$(uname -m)" env
if [ "$(uname -m)" = "arm64" ] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  smoke x86_64 arch -x86_64
else
  echo "Rosetta is not available, so the x86_64 slice is not launched."
fi
