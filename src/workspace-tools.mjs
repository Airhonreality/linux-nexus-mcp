// Tools de solo-lectura/escritura, todas jaileadas al workspace activo.
// Ninguna ejecuta comandos — eso es sandbox-exec.mjs, con su propio gate
// de confirmación. Ver README.md para el modelo de amenaza completo.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { resolve, relative, join, sep, dirname } from 'path';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.playwright-mcp']);

export function resolveWithinWorkspace(workspaceRoot, relPath) {
  const root = resolve(workspaceRoot);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`Ruta fuera del workspace permitido: ${relPath}`);
  }
  return abs;
}

function globToRegex(patron) {
  const escaped = patron.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped, 'i');
}

export function exploreTool(workspaceRoot, patron) {
  const root = resolve(workspaceRoot);
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(root, full));
    }
  }
  walk(root);
  if (!patron) return files;
  const re = globToRegex(patron);
  return files.filter((f) => re.test(f));
}

export function readTool(workspaceRoot, ruta) {
  if (!ruta) throw new Error('Falta el argumento "ruta".');
  const abs = resolveWithinWorkspace(workspaceRoot, ruta);
  if (!existsSync(abs)) throw new Error(`No existe: ${ruta}`);
  return readFileSync(abs, 'utf-8');
}

export function writeTool(workspaceRoot, ruta, contenido) {
  if (!ruta || contenido == null) {
    throw new Error('Faltan argumentos: se necesitan ruta y contenido.');
  }
  const abs = resolveWithinWorkspace(workspaceRoot, ruta);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contenido, 'utf-8');
  return `Escrito ${ruta} (${Buffer.byteLength(contenido, 'utf-8')} bytes).`;
}
