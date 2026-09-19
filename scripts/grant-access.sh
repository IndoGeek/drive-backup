#!/usr/bin/env bash

set -euo pipefail

U="${1:-}"
DEST="${2:-}"
if [[ -z "$U" || -z "$DEST" ]]; then
  echo "usage: sudo $0 <username> <directory-to-backup>" >&2
  exit 1
fi
if ! id "$U" >/dev/null 2>&1; then
  echo "error: no such user '$U'" >&2
  exit 1
fi
if [[ ! -d "$DEST" ]]; then
  echo "error: '$DEST' is not an accessible directory" >&2
  exit 1
fi

if ! command -v setfacl >/dev/null 2>&1; then
  echo "installing 'acl' package (setfacl)..."
  if command -v apt-get >/dev/null 2>&1; then apt-get install -y acl
  elif command -v dnf >/dev/null 2>&1; then dnf install -y acl
  elif command -v yum >/dev/null 2>&1; then yum install -y acl
  else
    echo "error: install the 'acl' package manually (provides setfacl)" >&2
    exit 1
  fi
fi

echo "granting $U read+traverse access on $DEST (existing files + dirs)..."
setfacl -R -m "u:$U:rX" -- "$DEST"

echo "setting default ACL so files the server creates later are also readable..."
setfacl -R -d -m "u:$U:rX" -- "$DEST"

echo "granting $U traverse access on the parent path..."
p="$(dirname "$DEST")"
while :; do
  [[ "$p" != "/" ]] && setfacl -m "u:$U:X" -- "$p"
  parent="$(dirname "$p")"
  [[ "$parent" == "$p" ]] && break
  p="$parent"
done

if sudo -u "$U" test -r "$DEST" 2>/dev/null || runuser -u "$U" -- test -r "$DEST" 2>/dev/null; then
  echo "verified: $U can read $DEST"
else
  echo "warning: could not verify read access for $U on $DEST (permissions check above)"
fi

echo
echo "done. Backups now run without sudo:"
echo "  backup-mgr run --config config.yml"
echo "  pm2 start ecosystem.config.cjs     (runs as $U)"
