#!/bin/sh
set -eu
# A newly mounted Render disk may be root-owned. Only initialize its top-level
# ownership; never delete, replace, or recursively rewrite existing profiles.
mkdir -p /var/lib/tbd /etc/tbd
chown tbd:tbd /var/lib/tbd /etc/tbd
chmod 700 /var/lib/tbd /etc/tbd
exec gosu tbd "$@"
