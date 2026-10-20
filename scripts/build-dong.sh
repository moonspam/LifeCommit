#!/bin/sh
# Regenerates the LifeCommit+ (full) administrative-dong boundaries: android/app/src/full/assets/public/dong.geojson
# Source: vuski/admdongkor (CC BY 4.0), from Statistics Korea SGIS boundaries (KOGL Type 1). See the NOTICE next to the output.
set -eu
VER=ver20260701
SHA256=c01ef44a0eb00978662ba7a6240ccb1da287fb52abd85104a1758969d391132f
URL="https://raw.githubusercontent.com/vuski/admdongkor/master/$VER/HangJeongDong_$VER.geojson"
OUT="$(cd "$(dirname "$0")/.." && pwd)/android/app/src/full/assets/public/dong.geojson"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -sSfL -o "$TMP/src.geojson" "$URL"
echo "$SHA256  $TMP/src.geojson" | shasum -a 256 -c -
# 15% of vertices (shapes kept), only the name, ~11 m coordinate precision: ~3 MB, ~98% of points match the original dong
npx -y mapshaper@0.6.102 "$TMP/src.geojson" -simplify 15% keep-shapes -filter-fields adm_nm -o "$OUT" format=geojson precision=0.0001
