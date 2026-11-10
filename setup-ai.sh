#!/usr/bin/env bash
# Guarda la clave de un proveedor de IA sin mostrarla y reinicia el bot. Tus datos no se tocan.
# Uso: setup-ai.sh groq | setup-ai.sh claude
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-groq}" in
  groq)   NAME=GROQ_API_KEY ;;
  claude) NAME=ANTHROPIC_API_KEY ;;
  *) echo 'Uso: setup-ai.sh groq|claude' >&2; exit 1 ;;
esac

read -rsp "Pega tu clave para ${NAME} (no se verá): " KEY
echo

if [ "$NAME" = GROQ_API_KEY ]; then
  curl -fsS -o /dev/null -H "Authorization: Bearer ${KEY}" https://api.groq.com/openai/v1/models || {
    echo 'Groq rechazó esa clave. No guardé nada.' >&2
    exit 1
  }
fi

umask 077
grep -v "^${NAME}=" .env > .env.tmp || true
printf '%s=%s\n' "$NAME" "$KEY" >> .env.tmp
mv .env.tmp .env

docker compose up -d
echo 'Listo. Prueba en Telegram: ayer gasté como 15 en un menú'
