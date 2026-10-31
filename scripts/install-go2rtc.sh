#!/bin/zsh
# Downloads go2rtc (official GitHub release, macOS arm64) into <root>/bin.
set -eu
root=${0:A:h:h:h}
ver=${1:-v1.9.15}
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/go2rtc.zip" "https://github.com/AlexxIT/go2rtc/releases/download/$ver/go2rtc_mac_arm64.zip"
unzip -q "$tmp/go2rtc.zip" -d "$tmp/x"
install -m 755 "$tmp/x/go2rtc" $root/bin/go2rtc
rm -rf "$tmp"
$root/bin/go2rtc -version
