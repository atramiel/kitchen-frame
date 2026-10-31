#!/bin/zsh
# Installs and (re)starts the Kitchen Frame LaunchAgents. The plists in
# app/launchd are templates; __ROOT__ and __NODE__ are filled in here, so
# re-run this after moving the project folder.
# usage: install-agents.sh [go2rtc] [frame-server]   (default: both)
set -eu
root=${0:A:h:h:h}
node=$(command -v node)
agents=("$@")
(( $#agents )) || agents=(go2rtc frame-server)
mkdir -p ~/Library/LaunchAgents
for a in $agents; do
  plist=~/Library/LaunchAgents/com.frame.$a.plist
  sed -e "s|__ROOT__|$root|g" -e "s|__NODE__|$node|g" $root/app/launchd/com.frame.$a.plist > $plist
  plutil -lint -s $plist
  launchctl bootout gui/$(id -u)/com.frame.$a 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) $plist
  echo "started com.frame.$a (log: $root/logs/$a.log)"
done
