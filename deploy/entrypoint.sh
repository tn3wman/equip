#!/bin/sh
set -eu

# Railway mounts persistent volumes as root. Only the data directory needs
# ownership preparation; the application and source resolvers run as node.
mkdir -p "$EQUIP_DATA_DIR"
chown node:node "$EQUIP_DATA_DIR"
exec gosu node "$@"
