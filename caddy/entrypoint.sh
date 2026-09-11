#!/bin/sh
set -e

if [ -z "$PUBLIC_HOST" ]; then
    echo "ERROR: PUBLIC_HOST must be set (e.g. 1-2-3-4.sslip.io or your domain)"
    exit 1
fi

if [ -z "$BASIC_AUTH_USER" ] || [ -z "$BASIC_AUTH_PASSWORD" ]; then
    echo "ERROR: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be set"
    exit 1
fi

# Caddy erwartet einen bcrypt-Hash, das Klartext-Passwort bleibt nur in der .env
BASIC_AUTH_HASH=$(caddy hash-password --plaintext "$BASIC_AUTH_PASSWORD")
export BASIC_AUTH_HASH

exec "$@"
