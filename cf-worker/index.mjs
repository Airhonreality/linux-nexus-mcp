// Worker "puente": URL pública fija (*.workers.dev) que reenvía cada
// request al backend real (el quick tunnel de Cloudflare, que cambia de
// URL cada vez que se reinicia). El backend actual se lee de KV — lo
// actualiza scripts/run-tunnel.sh cada vez que el túnel se reconecta.
// No inspecciona ni modifica el header de auth (X-Nexus-Token) — solo
// hace de cañería transparente, la autenticación real la hace el gateway.

export default {
  async fetch(request, env) {
    const backend = await env.NEXUS_GATEWAY_KV.get('current_url');
    if (!backend) {
      return new Response(
        JSON.stringify({ error: 'gateway_unreachable', detail: 'No hay backend configurado en KV todavía.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const incoming = new URL(request.url);
    const target = new URL(backend);
    target.pathname = incoming.pathname;
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
