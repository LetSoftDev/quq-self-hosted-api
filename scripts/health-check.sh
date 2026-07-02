#!/usr/bin/env bash
set -euo pipefail

DEFAULT_PORT="3000"
ENV_FILE="${ENV_FILE:-.env}"

read_env_value() {
  local key="$1"

  if [[ ! -f "$ENV_FILE" ]]; then
    return 1
  fi

  awk -F '=' -v key="$key" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      gsub(/^'\''|'\''$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE"
}

build_url() {
  local input="${1:-}"

  if [[ -z "$input" ]]; then
    local port
    port="$(read_env_value "PORT" || true)"
    port="${port:-$DEFAULT_PORT}"
    printf 'http://localhost:%s/health' "$port"
    return
  fi

  if [[ "$input" == */health ]]; then
    printf '%s' "$input"
    return
  fi

  printf '%s/health' "${input%/}"
}

main() {
  if ! command -v curl >/dev/null 2>&1; then
    printf 'curl is required to run the health check.\n' >&2
    exit 127
  fi

  local url
  url="$(build_url "${1:-}")"

  printf 'Checking %s\n' "$url"

  local response
  if ! response="$(curl -fsS --max-time 10 "$url")"; then
    printf 'Health check failed: server did not return a successful response.\n' >&2
    printf 'Check server logs with:\n' >&2
    printf '  docker compose logs -f api\n' >&2
    printf '  pm2 logs quq-self-hosted-api\n' >&2
    exit 1
  fi

  if [[ "$response" != *'"status":"ok"'* && "$response" != *'"status": "ok"'* ]]; then
    printf 'Health check failed: unexpected response:\n%s\n' "$response" >&2
    exit 1
  fi

  printf 'Health check passed: %s\n' "$response"
}

main "$@"
