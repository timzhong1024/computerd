#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_LIST="${1:-$SCRIPT_DIR/apt-packages.txt}"

if [[ ! -f "$PACKAGE_LIST" ]]; then
  echo "package list not found: $PACKAGE_LIST" >&2
  exit 1
fi

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  APT_PREFIX=()
elif command -v sudo >/dev/null 2>&1; then
  APT_PREFIX=(sudo)
else
  echo "this script must run as root or with sudo available" >&2
  exit 1
fi

mapfile -t packages < <(grep -Ev '^\s*(#|$)' "$PACKAGE_LIST")

if [[ ${#packages[@]} -eq 0 ]]; then
  echo "no packages found in $PACKAGE_LIST" >&2
  exit 1
fi

"${APT_PREFIX[@]}" apt-get update
"${APT_PREFIX[@]}" apt-get install -y "${packages[@]}"
