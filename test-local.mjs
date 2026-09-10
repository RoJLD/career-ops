#!/usr/bin/env node
/**
 * test-local.mjs — run the self-tests of every script THIS checkout owns.
 *
 * WHY THIS EXISTS
 *
 * The local scripts (bundle.mjs, check-bundles.mjs, kpi.mjs, sponsor-check.mjs,
 * …) are registered inside test-all.mjs, which is a system-layer file
 * (update-system.mjs ships it). Every `update-system.mjs apply` replaces
 * test-all.mjs with upstream's copy and the registrations vanish — that is what
 * commit 3d21f3b ("take the 1.32.0 suite, re-register local scripts") was:
 * putting them back by hand, again. package.json is in the manifest too, so it
 * is no safer a home.
 *
 * A registration that has to be re-typed after every release is not a
 * registration, it is a chore with a decay rate. So this file does not hold a
 * list at all. It DISCOVERS the local scripts: a root-level `*.mjs` that
 * upstream's SYSTEM_PATHS does not name is, by definition, one of ours. Add a
 * new local script with a `--self-test` and it is covered the moment it exists;
 * an update that retires one removes it from the run automatically.
 *
 * This file is itself un-manifested, so nothing overwrites or prunes it — root
 * `.mjs` entries are listed individually in SYSTEM_PATHS, never by prefix, so a
 * name upstream does not ship is neither checked out over nor deleted. That is
 * the same reason bundle.mjs has survived several updates.
 *
 * Run: node test-local.mjs             (run every discovered self-test)
 *      node test-local.mjs --list      (just show what would run, and why)
 *      node test-local.mjs --json
 *      node test-local.mjs --help
 *
 * Exit 1 if any self-test fails. It does NOT replace test-all.mjs — it covers
 * the slice test-all.mjs keeps forgetting.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import { hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { extractArrayFromSource } from './update-system.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage:
  node test-local.mjs           # run every local script's --self-test
  node test-local.mjs --list    # show what would run, without running it
  node test-local.mjs --json    # machine-readable result
  node test-local.mjs --help

Local = a root-level *.mjs that update-system.mjs's SYSTEM_PATHS does not name.`;

/** This file and the test runners themselves — nothing to self-test here. */
const SKIP = new Set(['test-local.mjs', 'test-all.mjs']);

/**
 * Root-level scripts upstream does not ship.
 *
 * Read out of update-system.mjs's source rather than imported, because
 * SYSTEM_PATHS is `const`, not `export const` (only USER_PATHS is exported).
 * validate-system-paths-coverage.mjs:33 takes the same route; this is the
 * supported way to read that list, not a workaround.
 */
export function discoverLocalScripts(root = ROOT) {
  const updater = join(root, 'update-system.mjs');
  if (!existsSync(updater)) throw new Error('update-system.mjs not found — cannot tell local from system');
  const shipped = new Set(extractArrayFromSource(readFileSync(updater, 'utf-8'), 'SYSTEM_PATHS'));
  if (!shipped.size) throw new Error('SYSTEM_PATHS came back empty — refusing to call every script local');

  return readdirSync(root)
    .filter((f) => f.endsWith('.mjs') && !SKIP.has(f) && !shipped.has(f))
    .sort()
    .map((file) => ({
      file,
      hasSelfTest: readFileSync(join(root, file), 'utf-8').includes('--self-test'),
    }));
}

function run(root, script) {
  const r = spawnSync(process.execPath, [join(root, script), '--self-test'], { encoding: 'utf-8' });
  return { script, ok: r.status === 0, status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd() };
}

function main(argv) {
  const args = argv.slice(2);
  if (hasFlag(args, '--help')) { console.log(USAGE); return 0; }

  let discovered;
  try {
    discovered = discoverLocalScripts();
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const testable = discovered.filter((d) => d.hasSelfTest);
  const untested = discovered.filter((d) => !d.hasSelfTest);

  if (hasFlag(args, '--list')) {
    console.log(`${discovered.length} local script(s) — root *.mjs not in update-system.mjs's SYSTEM_PATHS:\n`);
    for (const d of testable) console.log(`  ${d.file}  --self-test`);
    for (const d of untested) console.log(`  ${d.file}  (no --self-test)`);
    return 0;
  }

  const results = testable.map((d) => run(ROOT, d.file));
  const failed = results.filter((r) => !r.ok);

  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify({ ok: failed.length === 0, results, untested: untested.map((u) => u.file) }, null, 2));
    return failed.length ? 1 : 0;
  }

  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.script}`);
    if (!r.ok) console.log(r.output.split('\n').map((l) => `       ${l}`).join('\n'));
  }
  if (untested.length) {
    console.log(`\n${untested.length} local script(s) with no --self-test: ${untested.map((u) => u.file).join(', ')}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} local self-tests passed`);
  return failed.length ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv));
}
