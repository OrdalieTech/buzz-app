#!/bin/sh
# Build the release tarball buzz-web-deploy installs: dist/ (the web build of
# HEAD) and Caddyfile. Prints its path, dist/buzz-web-<sha8>.tgz.
# Usage: VITE_BUZZ_COMMUNITIES=chat.example.com web/deploy/release.sh
set -eu
cd "$(dirname "$0")/../.."
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit your changes first: the tarball is named after HEAD." >&2
  exit 1
fi
out=dist/buzz-web-$(git rev-parse --short=8 HEAD).tgz
bin/pnpm web:build >&2
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -R dist/web "$stage/dist"
cp web/deploy/Caddyfile "$stage/"
# No macOS ._ files or extended attributes in the tarball.
COPYFILE_DISABLE=1 tar --no-xattrs -C "$stage" -czf "$out" dist Caddyfile
echo "$out"
