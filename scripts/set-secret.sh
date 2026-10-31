#!/bin/zsh
# Prompts for a secret without echoing it and writes <root>/secrets/<file>.env (mode 600).
# usage: set-secret.sh <file> <VAR> [<VAR> ...]
#   e.g. set-secret.sh protect PROTECT_HOST PROTECT_API_KEY
set -eu
root=${0:A:h:h:h}
file=$1; shift
out=$root/secrets/$file.env
umask 077
: > "$out.tmp"
for var in "$@"; do
  read -rs "val?$var: "; echo
  print -r -- "$var=$val" >> "$out.tmp"
done
mv "$out.tmp" "$out"
chmod 600 "$out"
echo "saved $out"
