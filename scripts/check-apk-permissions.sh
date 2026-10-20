#!/bin/sh
# Usage: scripts/check-apk-permissions.sh <apk> <allowlist-file>
# Fails if the APK's permission set differs from the allowlist (one permission name per line; '#' lines are reasons).
set -eu
AAPT2=$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/build-tools/*/aapt2 | tail -1)
RAW=$(mktemp)
TMP_PERMS=$(mktemp)
trap 'rm -f "$RAW" "$TMP_PERMS"' EXIT
"$AAPT2" dump permissions "$1" > "$RAW"
sed -n "s/^uses-permission: name='\([^']*\)'.*/\1/p" "$RAW" | sort > "$TMP_PERMS"
test -s "$TMP_PERMS"
grep -v -e "^#" -e "^$" "$2" | sort | diff - "$TMP_PERMS" && echo "permissions match allowlist"
