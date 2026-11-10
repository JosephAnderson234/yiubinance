#!/usr/bin/env bash
# Primera instalación en el VPS: guarda el token sin mostrarlo, detecta tu ID y levanta el bot.
set -euo pipefail
cd "$(dirname "$0")"

read -rsp 'Pega el token de @BotFather (no se verá): ' TOKEN
echo
API="https://api.telegram.org/bot${TOKEN}"

BOT_NAME=$(curl -fsS "${API}/getMe" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["username"])') || {
  echo 'Ese token no funciona. Revísalo en @BotFather.' >&2
  exit 1
}

echo "Abre https://t.me/${BOT_NAME} en Telegram y toca Iniciar. Te espero..."
while true; do
  FOUND=$(curl -fsS "${API}/getUpdates?timeout=30" | python3 -c '
import json, sys
msgs = [u["message"] for u in json.load(sys.stdin)["result"] if "message" in u]
if msgs:
    who = msgs[-1]["from"]
    print(who["id"], who.get("first_name", ""))
')
  [ -n "$FOUND" ] && break
done

OWNER_ID=${FOUND%% *}
read -rp "Mensaje recibido de ${FOUND#* } (ID ${OWNER_ID}). ¿Eres tú? [s/N] " OK
[ "$OK" = 's' ] || { echo 'Cancelado, no guardé nada.'; exit 1; }

umask 077
printf 'TELEGRAM_TOKEN=%s\nOWNER_ID=%s\n' "$TOKEN" "$OWNER_ID" > .env
docker compose up -d --build
echo 'Listo. Vuelve a Telegram: el bot ya te está esperando.'
