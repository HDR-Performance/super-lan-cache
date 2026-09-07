#!/bin/bash
set -e
# Existing chunk ownership is preserved. A full repair is an explicit opt-in.
mkdir -p /data/cache/cache /data/logs /data/manager
chown "${WEBUSER}:${WEBUSER}" /data/cache /data/cache/cache /data/logs
chmod 700 /data/manager
chown root:root /data/manager
if [ "${FORCE_PERMS_CHECK:-false}" = "true" ]; then
    find /data/cache /data/logs ! -user "${WEBUSER}" -exec chown "${WEBUSER}:${WEBUSER}" '{}' +
fi
