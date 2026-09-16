// Worker "puente": URL pública fija (*.workers.dev) que reenvía cada
// request al backend real (el quick tunnel de Cloudflare de la máquina
// correspondiente, que cambia de URL cada vez que se reinicia).
//
// Ruteo por instancia: la URL tiene la forma
//   https://<worker>.workers.dev/<instance_id>/mcp
// y el Worker busca en KV la clave `backend:<instance_id>` para saber a
// qué túnel reenviar. Cada máquina/carpeta que corre run-tunnel.sh con su
// propio NEXUS_INSTANCE_ID escribe únicamente su propia clave — así
// varias instancias conviven bajo el mismo Worker/KV sin pisarse.
//
// Compatibilidad: si la URL NO trae instance_id (es decir, es
// exactamente `/mcp`), se usa la clave legacy `current_url` — para no
// romper una URL ya configurada de antes de que existiera el ruteo por
// instancia.
//
// No inspecciona ni modifica el header de auth (X-Nexus-Token) — solo
// hace de cañería transparente, la autenticación real la hace el gateway.

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const segments = incoming.pathname.split('/').filter(Boolean);

    let kvKey;
    let restPath;
    if (segments.length >= 2 && segments[segments.length - 1] === 'mcp') {
      // /<instance_id>/mcp  (instance_id puede tener sub-segmentos, poco común)
      const instanceId = segments.slice(0, -1).join('/');
      kvKey = `backend:${instanceId}`;
      restPath = '/mcp';
    } else {
      // /mcp  (sin instancia — legacy, una sola instancia "default")
      kvKey = 'current_url';
      restPath = incoming.pathname;
    }

    const backend = await env.NEXUS_GATEWAY_KV.get(kvKey);
    if (!backend) {
      return new Response(
        JSON.stringify({ error: 'gateway_unreachable', detail: `No hay backend configurado en KV para "${kvKey}".` }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const target = new URL(backend);
    target.pathname = restPath;
    target.search = incoming.search;

    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.delete('host');

    const proxied = new Request(target.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'follow',
    });

    try {
      return await fetch(proxied);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'backend_unreachable', detail: String(err) }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};
