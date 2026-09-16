# linux-nexus-mcp

Gateway MCP remoto para Linux: expone una carpeta local (archivos +
ejecución de comandos) a cualquier chat con soporte MCP nativo
(HuggingChat, ModelScope, etc.), a través de un túnel público con **URL
fija y gratuita** (Cloudflare Workers + Quick Tunnel).

## Qué hace

- 4 tools MCP: `explore` (listar archivos), `read`, `write` (crear/sobreescribir
  archivos), `run_command` (ejecutar comandos de shell).
- **`run_command` nunca corre nada sin que vos lo apruebes**: dispara un
  diálogo (`kdialog`) en el escritorio de esta máquina. Sin sesión
  gráfica disponible, deniega — nunca cuelga ni auto-aprueba.
- Además del gate de aprobación, todo comando corre dentro de un sandbox
  (`@anthropic-ai/sandbox-runtime`: sin red, solo puede tocar archivos
  del workspace activo) — la aprobación humana y el sandbox son capas
  independientes, ninguna reemplaza a la otra.
- Todo queda registrado en `~/.local/state/nexus-os/gateway-audit.log`.

## Por qué existe

Chats web con MCP nativo (a diferencia de los que solo tienen chat de
texto) pueden llamar tools reales — pero corren en la nube de un
tercero, no en tu máquina. Este gateway expone tu filesystem/terminal
local de forma controlada: con auth por token, aprobación humana
obligatoria para comandos, y sandboxing — para que puedas usar esos
chats como si fueran un agente de código con acceso real a tu compu, sin
regalarles ejecución irrestricta.

## Instalación

Requiere: Node.js 18+, systemd (con soporte `--user`), un escritorio
Linux con `kdialog` o `notify-send` disponible (KDE los trae de fábrica;
en otros entornos instalalos aparte).

```bash
git clone https://github.com/Airhonreality/linux-nexus-mcp.git
cd linux-nexus-mcp
bash install.sh
```

El instalador:
1. Instala las dependencias de npm.
2. Descarga `cloudflared` a `~/.local/bin` (sin sudo).
3. Te pregunta qué carpeta querés servir, genera un token, y guarda todo
   en `~/.config/nexus-os/gateway.env` (fuera del repo, nunca se commitea).
4. Instala los comandos `nurl` y `nexus-gateway` en `~/.local/bin`.
5. Registra y arranca dos servicios `systemd --user` (gateway + túnel),
   con `loginctl enable-linger` para que sobrevivan un reinicio de la
   máquina sin necesitar sesión gráfica iniciada.
6. Opcionalmente (te pregunta), configura una **URL pública fija y
   gratuita** con Cloudflare Workers — necesita una cuenta de Cloudflare
   (gratis) y hace login por navegador una vez.
7. Genera `CONEXION_MCP.md` en la raíz del repo con la URL/token listos
   para copiar — ese archivo nunca se commitea (tiene el token real).

Repetible: correr `install.sh` de nuevo no rompe nada, reusa lo que ya
existe.

## Uso día a día

```bash
cat CONEXION_MCP.md               # URL + header + token para pegar en el chat
nexus-gateway ~/otro/proyecto     # apunta el gateway a otra carpeta y reinicia
nurl                              # URL actual del túnel de abajo (no es la fija)
tail -f ~/.local/state/nexus-os/gateway-audit.log
```

Al conectar el chat, pegás la **URL** y agregás un header HTTP:
`X-Nexus-Token: <tu token>` (todo está en `CONEXION_MCP.md`).

## Sin URL fija (más simple, sin cuenta de Cloudflare)

Si en `install.sh` respondés que no a la parte de Workers, el gateway
igual funciona — solo que la URL del túnel (`*.trycloudflare.com`)
cambia cada vez que el servicio se reinicia. Para verla:
`nurl`. Podés agregar la URL fija después corriendo `install.sh` de
nuevo.

## Varias máquinas/carpetas vivas al mismo tiempo

Cada instalación tiene un **`NEXUS_INSTANCE_ID`** (por default, el
hostname de la máquina — `install.sh` te lo pregunta). Con eso, la URL
pública fija queda:

```
https://nexus-gateway-proxy.<tu-subdominio>.workers.dev/<instance_id>/mcp
```

Instalás igual (`git clone` + `bash install.sh`) en cada máquina que
quieras tener viva a la vez — **usando la misma cuenta de Cloudflare**
en todas (mismo Worker, mismo KV; el ruteo por instancia hace que no se
pisen entre sí). Cada máquina termina con su propia URL fija, todas bajo
el mismo dominio base. En el chat (HuggingChat, etc.) agregás **una
entrada "Custom Server" por máquina** — cada una con su URL y su propio
interruptor, así elegís con cuál hablar en cada conversación (o dejás
varias prendidas si querés que el modelo tenga acceso a más de una a la
vez).

Una sola máquina puede seguir sirviendo una sola carpeta a la vez
(cambiás con `nexus-gateway <carpeta>`, como siempre) — lo que este
mecanismo agrega es poder tener **máquinas distintas** respondiendo en
paralelo, no múltiples carpetas simultáneas dentro de una misma máquina
(para eso hace falta correr una segunda instancia del gateway en otro
puerto ahí mismo — no armado todavía, avisar si hace falta).

**Compatibilidad:** una URL vieja sin `/instance_id/` (`.../mcp` pelado)
sigue funcionando — usa la clave legacy `current_url` en KV. No hace
falta reconfigurar un chat ya armado antes de este cambio, salvo que
quieras pasarlo al esquema con nombre.

## Modelo de seguridad (resumen)

- Auth por header (`X-Nexus-Token`), comparación de tiempo constante
  (hash SHA-256 + `timingSafeEqual`).
- `run_command` exige aprobación humana local (`kdialog`) — no hay forma
  de que un chat remoto ejecute algo sin que lo veas y apruebes en tu
  pantalla.
- Sandbox (`sandbox-runtime`) como segunda capa independiente: sin red,
  filesystem limitado al workspace activo, con el propio `gateway.env`
  explícitamente denegado (para que un comando aprobado no pueda leer el
  token).
- Todo intento (aprobado, denegado, ejecutado) queda auditado con
  timestamp.
- `explore`/`read`/`write` están jaileados al workspace activo — ninguna
  ruta puede escapar de esa carpeta (`../`, rutas absolutas afuera, etc.)

No es un sandbox perfecto ni pretende serlo — es defensa en profundidad
razonable para uso personal. Revisá el código (`src/`) antes de
exponerlo si te importa entender exactamente qué puede hacer.

## Estructura

```
src/
  server.mjs           # servidor MCP HTTP + auth
  workspace-tools.mjs  # explore/read/write, jaileados al workspace
  confirm.mjs          # gate de confirmación (kdialog) + auditoría
  sandbox-exec.mjs      # run_command sandboxeado
systemd/                # templates de los 2 servicios
scripts/
  run-tunnel.sh         # cloudflared + actualiza Cloudflare KV
  generate-conexion-md.sh
cf-worker/               # Worker puente para la URL fija
install.sh
```
