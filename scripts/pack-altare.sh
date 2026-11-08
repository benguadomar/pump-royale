#!/usr/bin/env bash
# Builds deploy/altare/pump-royale-server.zip: the game server ready to upload to a Node.js
# server on Altare (or any panel host), with a generated .env holding its secrets.
#   NGROK_DOMAIN     ngrok static domain the server should claim (default below)
#   ALLOWED_ORIGINS  sites allowed to host the game page (default: the Netlify site)
set -euo pipefail
cd "$(dirname "$0")/.."

NGROK_DOMAIN="${NGROK_DOMAIN:-daughter-reclusive-attendant.ngrok-free.dev}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://keen-gaufre-70ceef.netlify.app}"
NGROK_YML="$HOME/Library/Application Support/ngrok/ngrok.yml"
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-$(sed -n 's/^ *authtoken: *//p' "$NGROK_YML" 2>/dev/null | head -1)}"
[ -n "$NGROK_AUTHTOKEN" ] || { echo "No ngrok authtoken found (set NGROK_AUTHTOKEN)"; exit 1; }

OUT=deploy/altare
STAGE="$OUT/pump-royale-server"
rm -rf "$OUT" && mkdir -p "$STAGE/src"

# The server also serves the game itself at its own address (same origin, no VITE_SERVER_URL).
npx vite build --logLevel warn
cp -R dist server package.json package-lock.json "$STAGE/"
cp -R src/sim src/data "$STAGE/src/"
rm -rf "$STAGE/server/data" "$STAGE/server/data-backups"

cat > "$STAGE/.env" <<EOF
NODE_ENV=production
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 24)
NGROK_AUTHTOKEN=$NGROK_AUTHTOKEN
NGROK_DOMAIN=$NGROK_DOMAIN
ALLOWED_ORIGINS=$ALLOWED_ORIGINS
PUBLIC_URL=https://$NGROK_DOMAIN
EOF

(cd "$STAGE" && zip -qr ../pump-royale-server.zip . -x '*.DS_Store')
echo "Built $OUT/pump-royale-server.zip ($(du -h "$OUT/pump-royale-server.zip" | cut -f1))"
echo "Admin token (keep it secret): $(sed -n 's/^ADMIN_TOKEN=//p' "$STAGE/.env")"
