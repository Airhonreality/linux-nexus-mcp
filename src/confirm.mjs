import { execFileSync, spawn } from 'child_process';
import { mkdirSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const AUDIT_LOG_DIR = join(homedir(), '.local', 'state', 'nexus-os');
const AUDIT_LOG_PATH = join(AUDIT_LOG_DIR, 'gateway-audit.log');

function getGraphicalEnv() {
  try {
    const out = execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf-8' });
    const env = {};
    for (const line of out.split('\n')) {
      const [key, ...rest] = line.split('=');
      if (['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS'].includes(key)) {
        env[key] = rest.join('=');
      }
    }
    return env;
  } catch {
    return {};
  }
}

export function logAudit(entry) {
  mkdirSync(AUDIT_LOG_DIR, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  appendFileSync(AUDIT_LOG_PATH, line + '\n', 'utf-8');
}

export function requestConfirmation({ title, message, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const graphicalEnv = getGraphicalEnv();
    const hasDisplay = graphicalEnv.DISPLAY || graphicalEnv.WAYLAND_DISPLAY;
    if (!hasDisplay || !graphicalEnv.DBUS_SESSION_BUS_ADDRESS) {
      resolve(false);
      return;
    }

    const child = spawn('kdialog', ['--title', title, '--warningyesno', message], {
      env: { ...process.env, ...graphicalEnv },
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve(false);
    }, timeoutMs);

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
}