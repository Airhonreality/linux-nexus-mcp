#!/usr/bin/env bash
# Regenera CONEXION_MCP.md (raíz del repo) con los valores reales actuales
# de ~/.config/nexus-os/gateway.env. Se corre solo (desde install.sh) o a
# mano cada vez que cambies el token/carpeta/URL fija a mano.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$HOME/.config/nexus-os/gateway.env"

if [[ ! -f "$CONFIG" ]]; then
  echo "Error: no existe $CONFIG — corré install.sh primero." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$CONFIG"; set +a

OUT="$REPO_DIR/CONEXION_MCP.md"

cat > "$OUT" <<EOF
# Conexión al Gateway MCP — referencia rápida

**Este archivo NO se sube a git** (tiene el token real). Se regenera con
\`scripts/generate-conexion-md.sh\` cada vez que cambie algo.

## Datos para pegar en el chat (HuggingChat, ModelScope, etc.)

| Campo | Valor |
|---|---|
| **URL** | \`${NEXUS_PUBLIC_URL:-<todavía no configurada, ver README sección Worker>}\` |
| **Header (nombre)** | \`X-Nexus-Token\` |
| **Header (valor / token)** | \`${NEXUS_GATEWAY_TOKEN}\` |

## Carpeta que está sirviendo el gateway ahora mismo

\`${NEXUS_WORKSPACE_ROOT}\`

(No confiar en este valor si usaste \`nexus-gateway <carpeta>\` después de
generar este archivo — correr de nuevo este script para actualizarlo.)

## Comandos útiles

\`\`\`bash
nurl                              # URL actual del quick tunnel de abajo (informativo, no es la que va en el chat)
nexus-gateway <carpeta>           # apunta el gateway a otra carpeta y reinicia todo
systemctl --user status nexus-gateway.service nexus-tunnel.service
tail -f ~/.local/state/nexus-os/gateway-audit.log
bash scripts/generate-conexion-md.sh   # regenerar este archivo
\`\`\`

## Dónde vive la config real

\`~/.config/nexus-os/gateway.env\` — token, puerto, carpeta activa, URL fija.
EOF

echo "CONEXION_MCP.md generado en: $OUT"
