#!/bin/sh
set -e

if [ -z "$BASIC_AUTH_USER" ] || [ -z "$BASIC_AUTH_PASSWORD" ]; then
    echo "ERROR: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be set"
    exit 1
fi

htpasswd -cb /etc/nginx/.htpasswd "$BASIC_AUTH_USER" "$BASIC_AUTH_PASSWORD"

exec "$@"
