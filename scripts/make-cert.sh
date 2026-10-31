#!/bin/zsh
# Makes a private CA (once) and a LAN certificate for frame-server, signed by it.
# No domain or public DNS needed: the Cozyla either trusts the CA
# (certs/frame-ca.crt installed on Android) or Fully Kiosk ignores SSL errors.
# usage: make-cert.sh <lan-ip> [extra-dns-name ...]
set -eu
root=${0:A:h:h:h}
ip=$1; shift
certs=$root/certs
mkdir -p $certs
umask 077

if [[ ! -f $certs/frame-ca.key ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout $certs/frame-ca.key -out $certs/frame-ca.crt \
    -subj "/CN=Kitchen Frame local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  echo "created CA $certs/frame-ca.crt"
fi

san="IP:$ip,DNS:$(scutil --get LocalHostName).local"
for name in "$@"; do san="$san,DNS:$name"; done

openssl req -newkey rsa:2048 -nodes -keyout $certs/frame.key -out $certs/frame.csr \
  -subj "/CN=$ip" 2>/dev/null
# 825 days is the longest validity Android/Chrome accept for a leaf from a user-installed CA.
openssl x509 -req -in $certs/frame.csr -CA $certs/frame-ca.crt -CAkey $certs/frame-ca.key -CAcreateserial \
  -days 825 -out $certs/frame.crt \
  -extfile <(printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n" "$san") 2>/dev/null
rm -f $certs/frame.csr
chmod 644 $certs/frame.crt $certs/frame-ca.crt
echo "issued $certs/frame.crt for $san"
