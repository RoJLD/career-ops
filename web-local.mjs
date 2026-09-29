#!/usr/bin/env node
/**
 * web-local.mjs — start the career-ops web dashboard bound to LOOPBACK only.
 *
 *   node web-local.mjs                 http://127.0.0.1:3000
 *   node web-local.mjs --port 3100     another port, still loopback
 *   node web-local.mjs --host ::1      IPv6 loopback
 *   node web-local.mjs --self-test     embedded tests (no server is started)
 *
 * Why this exists (measured 2026-09-29): a bare `npm run dev` makes Next listen on
 * 0.0.0.0. The 0.10 origin guard's Host layer compares the Host HEADER, which any
 * non-browser client on the network sets freely (`checkRequest({host:
 * 'localhost:3000', origin:null})` → ok) — and /api/run spawns `claude -p` with
 * Bash. Only the bind protects from the LAN, so this launcher refuses any
 * non-loopback host instead of trusting the guard to do it.
 *
 * Local file (declared in config/local-paths.txt), not part of the upstream system layer.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot } from './path-resolver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const KNOWN_FLAGS = ['--port', '--host', '--self-test', '--help', '-h'];

/** argv → { port, host } or { error }. Never returns a non-loopback host. */
export function parseArgs(argv) {
  const unknown = argv.filter((a, i) => a.startsWith('-') && !KNOWN_FLAGS.includes(a)
    && argv[i - 1] !== '--port' && argv[i - 1] !== '--host');
  if (unknown.length) return { error: `unrecognized flag(s): ${unknown.join(', ')}. Valid: ${KNOWN_FLAGS.join(', ')}` };

  let port = 3000;
  const pi = argv.indexOf('--port');
  if (pi !== -1) {
    const raw = argv[pi + 1];
    if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
      return { error: `--port expects an integer 1-65535, got "${raw ?? ''}"` };
    }
    port = Number(raw);
  }

  let host = '127.0.0.1';
  const hi = argv.indexOf('--host');
  if (hi !== -1) {
    const raw = argv[hi + 1];
    if (raw === undefined || !LOOPBACK.has(raw)) {
      return { error: `--host must be a loopback address (${[...LOOPBACK].join(', ')}), got "${raw ?? ''}" — `
        + 'anything else exposes /api/run (claude -p) to the network' };
    }
    host = raw;
  }
  return { port, host };
}

/** The exact process to spawn: node running Next's own bin, bound to `host`. */
export function buildCommand({ port, host }, { codeRoot = HERE, dataRoot } = {}) {
  const web = path.join(codeRoot, 'web');
  return {
    cmd: process.execPath, // no shell, no npm: nothing can re-add a default 0.0.0.0 bind
    args: [path.join(web, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-H', host, '-p', String(port)],
    cwd: web,
    env: { CAREER_OPS_ROOT: dataRoot },
  };
}

/** Problems that make launching pointless or unsafe, as human sentences. Empty = ready. */
export function preflight(codeRoot = HERE) {
  const web = path.join(codeRoot, 'web');
  const problems = [];
  if (!fs.existsSync(path.join(web, 'src', 'proxy.ts')) || !fs.existsSync(path.join(web, 'src', 'lib', 'origin-guard.mjs'))) {
    problems.push('web/ has no origin guard (src/proxy.ts, src/lib/origin-guard.mjs): resync web/ on upstream >= 0.10 first');
  }
  if (!fs.existsSync(path.join(web, 'node_modules', 'next', 'dist', 'bin', 'next'))) {
    problems.push('web/node_modules is missing (no Next bin): run `npm ci` in web/');
  }
  return problems;
}

function usage() {
  console.log(`
web-local.mjs — career-ops dashboard, loopback only

  node web-local.mjs                 http://127.0.0.1:3000
  node web-local.mjs --port 3100     another port (1-65535)
  node web-local.mjs --host ::1      loopback hosts only: 127.0.0.1, ::1, localhost
  node web-local.mjs --self-test     run the embedded tests

Never use a bare \`npm run dev\`: it listens on 0.0.0.0 and exposes /api/run
(which runs \`claude -p\`) to the network.
`.trim());
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return usage(), 0;
  if (argv.includes('--self-test')) return selfTest();
  const opts = parseArgs(argv);
  if (opts.error) { console.error(`web-local: ${opts.error}`); return 2; }
  const problems = preflight(HERE);
  if (problems.length) {
    for (const p of problems) console.error(`web-local: ${p}`);
    return 3;
  }
  const { cmd, args, cwd, env } = buildCommand(opts, { codeRoot: HERE, dataRoot: getCareerOpsRoot() });
  console.log(`web-local: http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${opts.port}/  (CAREER_OPS_ROOT=${env.CAREER_OPS_ROOT})`);
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  return null; // stay alive while Next runs
}

// ── Embedded tests ──────────────────────────────────────────────────

function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (cond, label) => {
    if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}`); }
  };
  const attempt = (fn) => { try { return fn(); } catch (e) { return { thrown: e.message }; } };

  const def = attempt(() => parseArgs([]));
  check(def.host === '127.0.0.1' && def.port === 3000, 'no flag → 127.0.0.1:3000');
  check(attempt(() => parseArgs(['--port', '3100'])).port === 3100, '--port 3100 is honoured');
  check(attempt(() => parseArgs(['--host', '::1'])).host === '::1', '--host ::1 (IPv6 loopback) is accepted');
  for (const bad of ['0.0.0.0', '192.168.1.30', '::', 'evil.example']) {
    check(typeof attempt(() => parseArgs(['--host', bad])).error === 'string', `--host ${bad} is refused (not loopback)`);
  }
  for (const bad of [['--port', 'abc'], ['--port', '0'], ['--port', '70000'], ['--port'], ['--host']]) {
    check(typeof attempt(() => parseArgs(bad)).error === 'string', `${bad.join(' ')} is refused`);
  }
  check(typeof attempt(() => parseArgs(['--bogus'])).error === 'string', 'an unknown flag is refused, never ignored');

  const cmd = attempt(() => buildCommand({ port: 3100, host: '127.0.0.1' }, { codeRoot: '/c/co', dataRoot: '/d/data' }));
  const args = cmd.args || [];
  check(cmd.cmd === process.execPath, 'spawns the current node binary (no shell, no npm)');
  check(args[0] === path.join('/c/co', 'web', 'node_modules', 'next', 'dist', 'bin', 'next') && args[1] === 'dev',
    "runs Next's own bin: dev");
  check(args[args.indexOf('-H') + 1] === '127.0.0.1' && args[args.indexOf('-p') + 1] === '3100', 'passes -H <loopback> -p <port>');
  check(args.length > 0 && !args.includes('0.0.0.0'), 'never 0.0.0.0 in the argv');
  check(cmd.cwd === path.join('/c/co', 'web') && cmd.env?.CAREER_OPS_ROOT === '/d/data', 'cwd = web/, CAREER_OPS_ROOT = data root');

  const vide = fs.mkdtempSync(path.join(os.tmpdir(), 'web-local-selftest-'));
  try {
    const probs = attempt(() => preflight(vide));
    check(Array.isArray(probs) && probs.some((p) => /node_modules/.test(p)), 'preflight names a missing web/node_modules');
    check(Array.isArray(probs) && probs.some((p) => /origin guard/.test(p)), 'preflight names a missing origin guard (proxy.ts / origin-guard.mjs)');
    fs.mkdirSync(path.join(vide, 'web', 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(vide, 'web', 'node_modules', 'next', 'dist', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(vide, 'web', 'src', 'proxy.ts'), '');
    fs.writeFileSync(path.join(vide, 'web', 'src', 'lib', 'origin-guard.mjs'), '');
    fs.writeFileSync(path.join(vide, 'web', 'node_modules', 'next', 'dist', 'bin', 'next'), '');
    const ok = attempt(() => preflight(vide));
    check(Array.isArray(ok) && ok.length === 0, 'preflight is empty when guard + Next bin are present');
  } finally {
    fs.rmSync(vide, { recursive: true, force: true });
  }

  // CLI contract: a refused host exits 2 before anything is spawned, nothing on stdout.
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, [self, '--host', '0.0.0.0'], { encoding: 'utf-8', timeout: 15000 });
  check(r.status === 2 && r.stdout === '' && /loopback/.test(r.stderr), 'CLI: --host 0.0.0.0 exits 2, says why, starts nothing');

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

const code = main(process.argv.slice(2));
if (code !== null) process.exit(code);
