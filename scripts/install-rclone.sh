#!/usr/bin/env bash
# Installs the rclone version the monitoring server pins, checksum-checked, so CI and the servers upload to R2 the same way.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
pin() { sed -n "s/^$1=//p" "$ROOT/infra/monitoring/setup.sh"; }

version=$(pin RCLONE_VERSION)
case $(dpkg --print-architecture) in
  arm64) sha256=$(pin RCLONE_SHA256_arm64) arch=arm64 ;;
  amd64) sha256=$(pin RCLONE_SHA256_amd64) arch=amd64 ;;
  *) echo "no pinned rclone checksum for $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
[[ -n $version && -n $sha256 ]] || { echo "rclone pin not found in infra/monitoring/setup.sh" >&2; exit 1; }

if [[ $(rclone version 2>/dev/null | head -n 1) == "rclone v$version" ]]; then
  echo "rclone $version already installed"
  exit 0
fi
deb=$(mktemp --suffix=.deb)
trap 'rm -f "$deb"' EXIT
curl -fsSL -o "$deb" "https://github.com/rclone/rclone/releases/download/v${version}/rclone-v${version}-linux-${arch}.deb"
echo "$sha256  $deb" | sha256sum -c --quiet -
sudo dpkg -i "$deb" >/dev/null
rclone version | head -n 1
