#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

# Sincroniza AmazonAccount.data.ads_refresh_token -> server/.env sem imprimir o token.
# Uso a partir da raiz do repositório na VPS:
#   bash server/scripts/sync-ads-refresh-token-env.sh <amazon_account_id>

ACCOUNT_ID="${1:-}"
if [[ -z "$ACCOUNT_ID" ]]; then
  echo "ERRO: informe amazon_account_id" >&2
  exit 2
fi
if [[ ! "$ACCOUNT_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "ERRO: amazon_account_id contém caracteres inválidos" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SERVER_DIR/.env"
COMPOSE_FILE="$SERVER_DIR/docker-compose.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERRO: $ENV_FILE não encontrado" >&2
  exit 3
fi
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERRO: $COMPOSE_FILE não encontrado" >&2
  exit 3
fi

TOKEN="$(
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T db \
    psql -U livingfinds -d livingfinds -At \
    -c "SELECT COALESCE(data->>'ads_refresh_token','') FROM amazon_account WHERE id='${ACCOUNT_ID}' LIMIT 1;" \
    | tr -d '\r\n'
)"

if [[ "$TOKEN" != Atzr\|* || ${#TOKEN} -lt 50 ]]; then
  unset TOKEN
  echo "ERRO: banco não contém refresh token Amazon Ads válido para a conta informada" >&2
  exit 4
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ENV_FILE.bak.$STAMP"
cp "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"

TMP="$(mktemp "$SERVER_DIR/.env.amazon-ads.XXXXXX")"
cleanup() {
  rm -f "$TMP" 2>/dev/null || true
  unset TOKEN
}
trap cleanup EXIT

FOUND=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == ADS_REFRESH_TOKEN=* ]]; then
    printf 'ADS_REFRESH_TOKEN=%s\n' "$TOKEN" >> "$TMP"
    FOUND=1
  else
    printf '%s\n' "$line" >> "$TMP"
  fi
done < "$ENV_FILE"

if [[ "$FOUND" -eq 0 ]]; then
  printf '\nADS_REFRESH_TOKEN=%s\n' "$TOKEN" >> "$TMP"
fi

chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT
unset TOKEN

# Recria somente o app para carregar o .env novo. O banco permanece intacto.
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate app >/dev/null

echo "OK: ADS_REFRESH_TOKEN sincronizado do banco para server/.env sem exibir o valor."
echo "Backup restrito criado em: $BACKUP"
echo "Container app recriado para carregar a nova variável."
