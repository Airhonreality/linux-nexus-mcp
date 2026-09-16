import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';
import { timingSafeEqual, createHash } from 'crypto';
import { z } from 'zod';
import { exploreTool, readTool, writeTool } from './workspace-tools.mjs';
import { requestConfirmation, logAudit } from './confirm.mjs';
import { initSandbox, runCommand } from './sandbox-exec.mjs';

const PORT = parseInt(process.env.NEXUS_GATEWAY_PORT || '8787', 10);
const TOKEN = process.env.NEXUS_GATEWAY_TOKEN;
const WORKSPACE_ROOT = process.env.NEXUS_WORKSPACE_ROOT || process.cwd();

if (!TOKEN) {
  console.error('ERROR: NEXUS_GATEWAY_TOKEN environment variable is required');
  process.exit(1);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf-8').digest();
}

const tokenHash = sha256(TOKEN);

function validateToken(req) {
  const header = req.headers['x-nexus-token'];
  if (!header || Array.isArray(header)) {
    return false;
  }
  return timingSafeEqual(sha256(header), tokenHash);
}

// Modo stateless: una McpServer + transport NUEVOS por request (no se puede
// reusar la misma instancia de McpServer entre requests — la SDK tira
// "Already connected to a transport" al segundo request si se reusa).
function getServer() {
  const server = new McpServer({
    name: 'nexus-gateway',
    version: '0.1.0',
  });

  server.tool(
    'explore',
    'List files in the workspace, optionally filtered by a glob pattern',
    {
      patron: z.string().optional().describe('Optional glob pattern to filter files (e.g., "*.mjs", "src/**")'),
    },
    async ({ patron }) => {
      const files = exploreTool(WORKSPACE_ROOT, patron);
      return { content: [{ type: 'text', text: JSON.stringify(files, null, 2) }] };
    }
  );

  server.tool(
    'read',
    'Read the contents of a file in the workspace',
    {
      ruta: z.string().describe('Path to the file relative to workspace root'),
    },
    async ({ ruta }) => {
      const content = readTool(WORKSPACE_ROOT, ruta);
      return { content: [{ type: 'text', text: content }] };
    }
  );

  server.tool(
    'write',
    'Crea o sobreescribe un archivo dentro del workspace, creando carpetas intermedias si hacen falta',
    {
      ruta: z.string().describe('Ruta relativa al workspace donde escribir'),
      contenido: z.string().describe('Contenido completo del archivo'),
    },
    async ({ ruta, contenido }) => {
      const msg = writeTool(WORKSPACE_ROOT, ruta, contenido);
      return { content: [{ type: 'text', text: msg }] };
    }
  );

  server.tool(
    'run_command',
    'Ejecuta un comando de shell dentro del workspace. Requiere aprobación humana local antes de correr, y corre sandboxeado (sin red, solo puede tocar archivos del workspace).',
    {
      comando: z.string().describe('Comando de shell a ejecutar'),
    },
    async ({ comando }) => {
      const aprobado = await requestConfirmation({
        title: 'Nexus Gateway — Aprobar comando',
        message: `¿Permitir ejecutar este comando?\n\n${comando}`,
      });
      logAudit({ tool: 'run_command', command: comando, decision: aprobado ? 'approved' : 'denied' });
      if (!aprobado) {
        return {
          content: [{ type: 'text', text: 'Comando denegado (sin aprobación humana o sin sesión gráfica disponible).' }],
          isError: true,
        };
      }
      const resultado = await runCommand({ command: comando, cwd: WORKSPACE_ROOT });
      logAudit({ tool: 'run_command', command: comando, decision: 'executed', exitCode: resultado.exitCode, timedOut: resultado.timedOut });
      return {
        content: [{
          type: 'text',
          text: `exit code: ${resultado.exitCode}${resultado.timedOut ? ' (timeout, killed)' : ''}\n\nstdout:\n${resultado.stdout}\n\nstderr:\n${resultado.stderr}`,
        }],
      };
    }
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!validateToken(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (req.url === '/mcp' || req.url.startsWith('/mcp/')) {
    const server = getServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('Error manejando request MCP:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

async function main() {
  await initSandbox(WORKSPACE_ROOT);
  httpServer.listen(PORT, () => {
    console.log(`Nexus Gateway listening on port ${PORT} (MCP endpoint: /mcp)`);
    console.log(`Workspace: ${WORKSPACE_ROOT}`);
  });
}

main();
