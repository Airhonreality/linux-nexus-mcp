#!/usr/bin/env bash
# Instala Nexus MCP Gateway en esta máquina: dependencias, cloudflared,
# systemd (arranca solo en cada boot), y opcionalmente el Worker de
# Cloudflare para tener una URL pública fija y gratuita.
#
# Uso: bash install.sh
# Repetible: correrlo de nuevo no rompe nada (reusa lo que ya existe).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config/nexus-os"
CONFIG="$CONFIG_DIR/gateway.env"
BIN_DIR="$HOME/.local/bin"

echo "== Nexus MCP Gateway — instalador =="
echo "Repo: $REPO_DIR"

# 1. Dependencias de node
echo
echo "-- Instalando dependencias npm --"
(cd "$REPO_DIR" && npm install)

# 2. cloudflared
echo
echo "-- Verificando cloudflared --"
mkdir -p "$BIN_DIR"
if ! command -v cloudflared >/dev/null 2>&1 && [[ ! -x "$BIN_DIR/cloudflared" ]]; then
  echo "Descargando cloudflared a $BIN_DIR (sin sudo)..."
  curl -fL -o "$BIN_DIR/cloudflared" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$BIN_DIR/cloudflared"
else
  echo "cloudflared ya está disponible."
fi

# 3. Config (~/.config/nexus-os/gateway.env)
echo
echo "-- Configuración --"
mkdir -p "$CONFIG_DIR"
if [[ ! -f "$CONFIG" ]]; then
  read -rp "¿Qué carpeta querés servir por el gateway? [default: $PWD]: " WORKSPACE
  WORKSPACE="${WORKSPACE:-$PWD}"
  WORKSPACE="$(realpath "$WORKSPACE")"
  TOKEN="$(openssl rand -hex 32)"
  cat > "$CONFIG" <<EOF
NEXUS_GATEWAY_TOKEN=$TOKEN
NEXUS_GATEWAY_PORT=8787
NEXUS_WORKSPACE_ROOT=$WORKSPACE
EOF
  chmod 600 "$CONFIG"
  echo "Config nueva creada en $CONFIG"
else
  echo "Ya existe $CONFIG, lo dejo como está."
fi

# 4. CLIs cortos (nurl, nexus-gateway)
echo
echo "-- Instalando comandos nurl / nexus-gateway --"
cat > "$BIN_DIR/nurl" <<'EOF'
#!/usr/bin/env bash
journalctl --user -u nexus-tunnel.service --no-pager | grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' | tail -1
EOF
chmod +x "$BIN_DIR/nurl"

cat > "$BIN_DIR/nexus-gateway" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
CONFIG=~/.config/nexus-os/gateway.env
TARGET="$(realpath "${1:-$(pwd)}")"
if [[ ! -d "$TARGET" ]]; then
  echo "Error: '$TARGET' no es una carpeta válida." >&2
  exit 1
fi
if ! grep -q '^NEXUS_WORKSPACE_ROOT=' "$CONFIG"; then
  echo "NEXUS_WORKSPACE_ROOT=$TARGET" >> "$CONFIG"
else
  sed -i "s|^NEXUS_WORKSPACE_ROOT=.*|NEXUS_WORKSPACE_ROOT=$TARGET|" "$CONFIG"
fi
echo "Apuntando el gateway a: $TARGET"
systemctl --user restart nexus-gateway.service nexus-tunnel.service
sleep 6
systemctl --user is-active nexus-gateway.service nexus-tunnel.service
echo "URL actual del túnel:"
nurl
EOF
chmod +x "$BIN_DIR/nexus-gateway"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "AVISO: $BIN_DIR no está en tu PATH — agregalo a tu .bashrc/.zshrc/.config/fish/config.fish"
fi

# 5. systemd --user
echo
echo "-- Configurando systemd --user --"
chmod +x "$REPO_DIR/scripts/run-tunnel.sh"
mkdir -p "$HOME/.config/systemd/user"
sed "s|__REPO_DIR__|$REPO_DIR|g" "$REPO_DIR/systemd/nexus-gateway.service.template" > "$HOME/.config/systemd/user/nexus-gateway.service"
sed "s|__REPO_DIR__|$REPO_DIR|g" "$REPO_DIR/systemd/nexus-tunnel.service.template" > "$HOME/.config/systemd/user/nexus-tunnel.service"
systemctl --user daemon-reload
loginctl enable-linger "$USER" || echo "AVISO: no se pudo habilitar lingering automáticamente, corré 'loginctl enable-linger $USER' a mano."
systemctl --user enable --now nexus-gateway.service nexus-tunnel.service

echo "Esperando que el túnel tome una URL..."
for _ in $(seq 1 15); do
  URL="$("$BIN_DIR/nurl" || true)"
  [[ -n "$URL" ]] && break
  sleep 2
done
echo "URL del quick tunnel: ${URL:-<todavía no asignada, revisar 'journalctl --user -u nexus-tunnel.service'>}"

# 6. Worker de Cloudflare (URL fija, opcional)
echo
echo "-- URL pública fija (Cloudflare Workers) --"
read -rp "¿Configurar ahora una URL fija con Cloudflare Workers? (necesita cuenta de Cloudflare) [s/N]: " SETUP_WORKER
if [[ "$SETUP_WORKER" =~ ^[sS]$ ]]; then
  cd "$REPO_DIR/cf-worker"

  if ! npx -y wrangler whoami 2>&1 | grep -q "logged in"; then
    echo "Necesitás loguearte una vez. Se va a abrir tu navegador — aceptá el permiso RÁPIDO,"
    echo "la ventana de espera de 'wrangler login' es corta."
    npx -y wrangler login
  fi

  WHOAMI_OUT="$(npx -y wrangler whoami 2>&1)"
  ACCOUNT_ID="$(echo "$WHOAMI_OUT" | grep -oE '[a-f0-9]{32}' | head -1)"

  if [[ -z "$ACCOUNT_ID" ]]; then
    echo "No se pudo detectar el Account ID de Cloudflare. Configurá el Worker a mano (ver README)."
  else
    OAUTH_TOKEN="$(grep '^oauth_token' "$HOME/.config/.wrangler/config/default.toml" | sed 's/oauth_token = "\(.*\)"/\1/')"

    HAS_SUBDOMAIN="$(curl -s -H "Authorization: Bearer $OAUTH_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
      | grep -o '"subdomain": *"[^"]*"' | sed 's/"subdomain": *"\(.*\)"/\1/')"

    if [[ -z "$HAS_SUBDOMAIN" ]]; then
      read -rp "Elegí un subdominio *.workers.dev (único, para siempre en esta cuenta): " WANTED_SUBDOMAIN
      curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
        -H "Authorization: Bearer $OAUTH_TOKEN" -H "Content-Type: application/json" \
        -d "{\"subdomain\":\"$WANTED_SUBDOMAIN\"}" > /dev/null
      HAS_SUBDOMAIN="$WANTED_SUBDOMAIN"
    fi
    echo "Subdominio workers.dev: $HAS_SUBDOMAIN"

    if [[ ! -f wrangler.jsonc ]]; then
      EXISTING_ID="$(npx -y wrangler kv namespace list 2>&1 | grep -B1 'NEXUS_GATEWAY_KV' | grep -oE '[a-f0-9]{32}' | head -1)"
      if [[ -z "$EXISTING_ID" ]]; then
        KV_OUT="$(npx -y wrangler kv namespace create NEXUS_GATEWAY_KV 2>&1)"
        EXISTING_ID="$(echo "$KV_OUT" | grep -oE '"id": *"[a-f0-9]+"' | grep -oE '[a-f0-9]{32}')"
      fi
      sed "s|__KV_NAMESPACE_ID__|$EXISTING_ID|" wrangler.jsonc.example > wrangler.jsonc
    fi

    if [[ -n "${URL:-}" ]]; then
      npx -y wrangler kv key put --binding=NEXUS_GATEWAY_KV "current_url" "$URL" --remote || true
    fi

    npx -y wrangler deploy
    PUBLIC_URL="https://nexus-gateway-proxy.$HAS_SUBDOMAIN.workers.dev/mcp"
    if grep -q '^NEXUS_PUBLIC_URL=' "$CONFIG"; then
      sed -i "s|^NEXUS_PUBLIC_URL=.*|NEXUS_PUBLIC_URL=$PUBLIC_URL|" "$CONFIG"
    else
      echo "NEXUS_PUBLIC_URL=$PUBLIC_URL" >> "$CONFIG"
    fi
    echo "URL pública fija: $PUBLIC_URL"
  fi
  cd "$REPO_DIR"
else
  echo "Salteado — vas a usar la URL del quick tunnel (cambia en cada reinicio). Podés correr este script de nuevo cuando quieras agregarlo."
fi

# 7. CONEXION_MCP.md
echo
bash "$REPO_DIR/scripts/generate-conexion-md.sh"

echo
echo "== Listo =="
echo "Mirá $REPO_DIR/CONEXION_MCP.md para la URL/token a pegar en tu chat."
