#!/bin/sh
# Local staging for the web build at https://buzz.localhost:9443 (Caddy's
# local CA; browsers need its root trusted or certificate errors ignored).
# Usage: web/staging/staging.sh up | down
set -eu
cd "$(dirname "$0")"
case "${1:-}" in
up)
  # A throwaway relay key, kept out of the terminal and of Git (.env is ignored).
  [ -f .env ] || echo "BUZZ_RELAY_PRIVATE_KEY=$(openssl rand -hex 32)" >.env
  (cd ../.. && VITE_BUZZ_COMMUNITIES=buzz.localhost:9443 bin/pnpm web:build)
  docker compose up -d --wait
  ;;
down)
  docker compose down -v
  rm -f .env
  ;;
*)
  echo "usage: $0 up | down" >&2
  exit 2
  ;;
esac
