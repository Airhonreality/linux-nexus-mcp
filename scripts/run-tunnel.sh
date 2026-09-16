#!/usr/bin/env bash
# Envuelve cloudflared quick tunnel: extrae la URL asignada en cada arranque,
# la anuncia (notify-send si hay sesión gráfica, siempre por stdout/journal
# como respaldo) y la publica en Cloudflare KV para que el Worker puente
# (ver cf-worker/) la use como backend actual — así la URL PÚBLICA que se
# le da a un chat nunca cambia, aunque esta de acá (*.trycloudflare.com)
# sí cambie en cada reinicio.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CF_WORKER_DIR="$REPO_DIR/cf-worker"

GATEWAY_URL="${NEXUS_GATEWAY_LOCAL_URL:-http://127.0.0.1:8787}"
STATE_DIR="$HOME/.local/state/nexus-os"
mkdir -p "$STATE_DIR"

~/.local/bin/cloudflared tunnel --url "$GATEWAY_URL" 2>&1 | while IFS= read -r line; do
  echo "$line"
  if [[ "$line" == *"trycloudflare.com"* && "$line" == *"https://"* ]]; then
    url=$(echo "$line" | grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com')
    if [[ -n "$url" ]]; then
      echo "NEXUS_TUNNEL_URL=$url"
      if command -v notify-send >/dev/null 2>&1; then
        notify-send "Nexus Gateway" "Nueva URL del túnel: $url" || true
      fi
      if [[ -f "$CF_WORKER_DIR/wrangler.jsonc" ]]; then
        KV_KEY="current_url"
        if [[ -n "${NEXUS_INSTANCE_ID:-}" ]]; then
          KV_KEY="backend:${NEXUS_INSTANCE_ID}"
        fi
        (
          cd "$CF_WORKER_DIR" && \
          npx -y wrangler kv key put --binding=NEXUS_GATEWAY_KV "$KV_KEY" "$url" --remote \
            >> "$STATE_DIR/kv-update.log" 2>&1
        ) || echo "AVISO: no se pudo actualizar Cloudflare KV con la URL nueva"
      fi
    fi
  fi
done
