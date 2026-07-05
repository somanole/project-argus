// Launch + lifecycle for the two managed n8n instances (prod + staging).
//
// Isolation is by N8N_USER_FOLDER (own SQLite DB + encryption key + settings).
// The reference checkout ../n8n is only *run*, never modified.
//
// Ports (see contracts/DISCOVERY.md): prod/staging keep 5678/5679 as their main
// HTTP ports, but each instance's task-runner broker is moved off those ports
// (default N8N_RUNNERS_BROKER_PORT=5679 would otherwise collide with staging).

import { spawn } from 'node:child_process';
import { openSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileP = promisify(execFile);

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const N8N_DIR = resolve(REPO_ROOT, '..', 'n8n');
export const INSTANCES_DIR = join(REPO_ROOT, '.n8n-instances');

/** The two instances the estate is built from. */
export const INSTANCES = {
  prod: { name: 'prod', port: 5678, brokerPort: 6779, baseUrl: 'http://localhost:5678' },
  staging: { name: 'staging', port: 5679, brokerPort: 6780, baseUrl: 'http://localhost:5679' },
};

const userFolder = (inst) => join(INSTANCES_DIR, inst.name);
const pidFile = (inst) => join(userFolder(inst), 'n8n.pid');
const logFile = (inst) => join(userFolder(inst), 'n8n.log');

function envFor(inst) {
  const base = `${inst.baseUrl}/`;
  return {
    ...process.env,
    E2E_TESTS: 'true',
    N8N_PORT: String(inst.port),
    N8N_RUNNERS_BROKER_PORT: String(inst.brokerPort),
    N8N_USER_FOLDER: userFolder(inst),
    N8N_PROTOCOL: 'http',
    N8N_HOST: 'localhost',
    N8N_WEBHOOK_URL: base,
    N8N_EDITOR_BASE_URL: base,
    // Keep startup quiet + fast for a dev estate.
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_HIRING_BANNER_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  };
}

async function isHealthy(inst) {
  try {
    const res = await fetch(`${inst.baseUrl}/healthz`);
    return res.status === 200;
  } catch { return false; }
}

async function ourPidAlive(inst) {
  try {
    const pid = Number(readFileSync(pidFile(inst), 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0); // throws if not alive
    return true;
  } catch { return false; }
}

/** PIDs listening on a TCP port (macOS/Linux lsof). Empty if none/unavailable. */
async function listenersOn(port) {
  try {
    const { stdout } = await execFileP('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
    return stdout.split('\n').map((s) => Number(s.trim())).filter(Boolean);
  } catch { return []; }
}

async function killPid(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); } catch { return; } // gone
    await sleep(200);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Free the instance's HTTP + broker ports (kills disposable dev n8n on them). */
async function freePorts(inst) {
  for (const port of [inst.port, inst.brokerPort]) {
    for (const pid of await listenersOn(port)) {
      console.log(`  freeing :${port} (killing pid ${pid})`);
      await killPid(pid);
    }
  }
}

async function waitHealthy(inst, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (await isHealthy(inst)) return true;
    await sleep(500);
  }
  return false;
}

function spawnInstance(inst) {
  mkdirSync(userFolder(inst), { recursive: true });
  const out = openSync(logFile(inst), 'a');
  const child = spawn('pnpm', ['start'], {
    cwd: N8N_DIR,
    env: envFor(inst),
    detached: true,
    stdio: ['ignore', out, out],
  });
  writeFileSync(pidFile(inst), String(child.pid), 'utf8');
  child.unref();
  return child.pid;
}

/**
 * Ensure one instance is up and healthy. Reuses our own healthy instance; else
 * frees the ports and starts a clean managed one. Returns 'reused' | 'started'.
 */
export async function ensureInstance(inst) {
  if (await ourPidAlive(inst) && await isHealthy(inst)) {
    console.log(`  ${inst.name}: reusing running instance at ${inst.baseUrl}`);
    return 'reused';
  }
  console.log(`  ${inst.name}: starting at ${inst.baseUrl} (folder ${userFolder(inst)})`);
  await freePorts(inst);
  const pid = spawnInstance(inst);
  const ok = await waitHealthy(inst);
  if (!ok) {
    throw new Error(`${inst.name} did not become healthy at ${inst.baseUrl} (pid ${pid}); see ${logFile(inst)}`);
  }
  console.log(`  ${inst.name}: healthy (pid ${pid})`);
  return 'started';
}

/** Ensure both instances are up. Sequential — prod must free :5679's broker use before staging binds it. */
export async function ensureAll() {
  if (!existsSync(N8N_DIR)) throw new Error(`n8n checkout not found at ${N8N_DIR}`);
  mkdirSync(INSTANCES_DIR, { recursive: true });
  const outcomes = {};
  for (const inst of [INSTANCES.prod, INSTANCES.staging]) {
    outcomes[inst.name] = await ensureInstance(inst);
  }
  return outcomes;
}

/** Stop the managed instances we started (by pidfile). */
export async function stopAll() {
  for (const inst of [INSTANCES.prod, INSTANCES.staging]) {
    try {
      const pid = Number(readFileSync(pidFile(inst), 'utf8').trim());
      if (pid) { console.log(`  stopping ${inst.name} (pid ${pid})`); await killPid(pid); }
    } catch { /* not running */ }
  }
}
