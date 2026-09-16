import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'path';

let initialized = false;

export async function initSandbox(workspaceRoot) {
  if (initialized) return;
  const config = {
    network: {
      allowedDomains: [],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [
        process.env.HOME,
        join(workspaceRoot, 'gateway.env'),
      ],
      allowRead: [workspaceRoot],
      allowWrite: [workspaceRoot],
      denyWrite: [join(workspaceRoot, 'gateway.env')],
    },
  };
  await SandboxManager.initialize(config);
  initialized = true;
}

const MAX_OUTPUT_CHARS = 10000;

function truncate(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n...[truncado, ${text.length} caracteres totales]`;
}

export async function runCommand({ command, cwd }) {
  const commandId = randomUUID();
  const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, undefined, undefined, {
    commandId,
    commandText: command,
  });

  return new Promise((resolve) => {
    const child = spawn(wrapped, { shell: true, cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 60000);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: String(err), timedOut: false });
    });
  });
}