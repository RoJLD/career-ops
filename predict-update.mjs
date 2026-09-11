#!/usr/bin/env node
/**
 * predict-update.mjs — the dry run `update-system.mjs apply` does not have.
 *
 * The updater offers check / apply / rollback / dismiss. `check` answers "is
 * there an update?"; nothing answers the question you actually want answered
 * first: **will this delete something I wrote?**
 *
 * That gap is not academic. On 2026-09-07 an apply to v1.32.0 removed both
 * London CV templates — 576 lines, commit 7f11a6c — because they were tracked
 * in the code repo under the `templates/` system prefix and upstream had
 * stopped shipping them. Nothing warned beforehand. This script is that
 * warning.
 *
 * HOW IT STAYS HONEST
 *
 * It does not reimplement the prune. It imports `staleSystemFiles()` from
 * update-system.mjs and feeds it the same three inputs apply() does, so an
 * upstream change to the rule changes this prediction too. A hand-written copy
 * of the logic would drift silently and be worse than nothing — a dry run you
 * trust that no longer matches the thing it predicts.
 *
 * `SYSTEM_PATHS` is `const`, not `export const`, so it is read out of the
 * source with the exported `extractArrayFromSource()` — the same route
 * validate-system-paths-coverage.mjs takes. That is the supported way to read
 * it, not a workaround.
 *
 * WHY IT ASSUMES `preservedPaths` IS EMPTY
 *
 * apply() excludes locally-modified files from the prune via `preservedPaths`.
 * That protection expires: `atRisk` is diffed against the most recent
 * `chore: auto-update system files` commit, so once a fork file's content stops
 * changing it drops out of the set and becomes prunable. Predicting the empty
 * case predicts the case that loses data, which is the only one worth a
 * warning. A prediction that assumed the protection held would go quiet
 * exactly when the file became vulnerable.
 *
 * Reads only. Writes nothing. Runs no network calls of its own — it needs a
 * FETCH_HEAD, so run `node update-system.mjs check` (or `git fetch`) first.
 *
 * Run: node predict-update.mjs             (human-readable)
 *      node predict-update.mjs --json
 *      node predict-update.mjs --self-test
 *      node predict-update.mjs --help
 *
 * Exit 1 when the prune would delete something, so it can gate an apply.
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

import { hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  extractArrayFromSource,
  staleSystemFiles,
  effectiveUserPaths,
  USER_PATHS,
} from './update-system.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage:
  node predict-update.mjs             # what would apply --confirm delete?
  node predict-update.mjs --json      # machine-readable
  node predict-update.mjs --self-test # inline test suite
  node predict-update.mjs --help

Needs a FETCH_HEAD: run \`node update-system.mjs check\` first.
Exit 1 when the prune would delete a tracked file.`;

const gitIn = (root) => (...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' }).split('\n').filter(Boolean);

/**
 * Predict the prune, plus what the declaration file would change about it.
 *
 * Returns `{ doomed, doomedWithDeclaration, savedByDeclaration, ... }`.
 * `doomed` is what the shipped code deletes today; `doomedWithDeclaration` is
 * what it would delete if the prune honoured config/local-paths.txt. The two
 * differ whenever a declaration is silently failing to protect something —
 * which is the shape of the open upstream bug, not a hypothetical.
 */
export function predictUpdate(root = CODE_ROOT, { git = gitIn(root) } = {}) {
  const updater = `${root}/update-system.mjs`;
  if (!existsSync(updater)) throw new Error('update-system.mjs not found — not a career-ops checkout');

  const systemPaths = extractArrayFromSource(readFileSync(updater, 'utf-8'), 'SYSTEM_PATHS');
  if (!systemPaths.length) throw new Error('SYSTEM_PATHS came back empty — refusing to predict "nothing is system"');

  let remoteFiles;
  try {
    remoteFiles = git('ls-tree', '-r', '--name-only', 'FETCH_HEAD').map((p) => p.replace(/\\/g, '/'));
  } catch {
    throw new Error('no FETCH_HEAD — run `node update-system.mjs check` (or `git fetch`) first');
  }
  // A failed or empty tree lookup is not evidence the target ships nothing;
  // treating it as such would predict deleting the entire system layer.
  if (!remoteFiles.length) throw new Error('FETCH_HEAD lists no files — refusing to predict against an empty tree');

  const localFiles = git('ls-files');
  const doomed = staleSystemFiles(localFiles, remoteFiles, systemPaths, USER_PATHS);
  const doomedWithDeclaration = staleSystemFiles(localFiles, remoteFiles, systemPaths, effectiveUserPaths(root));
  const savedByDeclaration = doomed.filter((f) => !doomedWithDeclaration.includes(f));

  const untracked = git('ls-files', '--others', '--exclude-standard');
  const ignored = git('ls-files', '--others', '--ignored', '--exclude-standard');

  return {
    ok: doomed.length === 0,
    counts: { systemPaths: systemPaths.length, localFiles: localFiles.length, remoteFiles: remoteFiles.length },
    doomed,
    doomedWithDeclaration,
    savedByDeclaration,
    invisibleToPrune: { untracked: untracked.length, ignoredUntracked: ignored.length },
  };
}

function render(r) {
  const lines = [];
  lines.push(`SYSTEM_PATHS ${r.counts.systemPaths} · tracked ${r.counts.localFiles} · upstream ${r.counts.remoteFiles}`);
  lines.push('');
  if (!r.doomed.length) {
    lines.push('The stale-file prune would delete NOTHING.');
  } else {
    lines.push(`The stale-file prune would DELETE ${r.doomed.length} tracked file(s):`);
    for (const f of r.doomed) lines.push(`  ${f}`);
  }
  if (r.savedByDeclaration.length) {
    lines.push('');
    lines.push(`${r.savedByDeclaration.length} of those are declared in config/local-paths.txt and are deleted anyway —`);
    lines.push('the prune reads the bare USER_PATHS constant, not the declaration file:');
    for (const f of r.savedByDeclaration) lines.push(`  ${f}`);
    lines.push('');
    lines.push('Move them out of the code repo\'s index (gitignore + the personal repo).');
    lines.push('A declaration cannot save a file the prune never asks about.');
  }
  lines.push('');
  lines.push(`Invisible to the prune (not in git ls-files): ${r.invisibleToPrune.untracked} untracked, ${r.invisibleToPrune.ignoredUntracked} ignored.`);
  lines.push(r.ok ? '\nSafe to apply, as far as deletion goes.' : '\nDo NOT apply until the listed files are out of the index.');
  return lines.join('\n');
}

// --- self-test ---------------------------------------------------------------

function selfTest() {
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); }
    catch (err) { results.push({ name, ok: false, error: err.message }); }
  };
  const eq = (a, b, label) => { if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`); };

  // A fake git whose answers are fixtures, so the prediction is exercised
  // without a checkout, a network, or a FETCH_HEAD.
  const fakeGit = ({ local, remote, untracked = [], ignored = [] }) => (...args) => {
    const a = args.join(' ');
    if (a.includes('ls-tree')) return remote;
    if (a.includes('--ignored')) return ignored;
    if (a.includes('--others')) return untracked;
    return local;
  };

  check('a file upstream still ships is not doomed', () => {
    const r = predictUpdate(CODE_ROOT, { git: fakeGit({ local: ['update-system.mjs'], remote: ['update-system.mjs'] }) });
    eq(r.doomed.length, 0, 'doomed');
    eq(r.ok, true, 'ok');
  });

  check('a root .mjs upstream does not ship is NOT a prune candidate', () => {
    // Root scripts are named individually in SYSTEM_PATHS, never by prefix,
    // which is why bundle.mjs has survived several updates.
    const r = predictUpdate(CODE_ROOT, { git: fakeGit({ local: ['bundle.mjs'], remote: ['update-system.mjs'] }) });
    eq(r.doomed.length, 0, 'doomed');
  });

  check('a tracked file under a system DIRECTORY prefix is doomed', () => {
    const r = predictUpdate(CODE_ROOT, {
      git: fakeGit({ local: ['templates/cv-template.london.html'], remote: ['update-system.mjs'] }),
    });
    eq(r.doomed.length, 1, 'doomed');
    eq(r.doomed[0], 'templates/cv-template.london.html', 'path');
    eq(r.ok, false, 'ok');
  });

  check('an empty upstream tree is refused, never read as "delete everything"', () => {
    let threw = false;
    try { predictUpdate(CODE_ROOT, { git: fakeGit({ local: ['templates/x.html'], remote: [] }) }); }
    catch { threw = true; }
    if (!threw) throw new Error('expected a throw');
  });

  check('a missing FETCH_HEAD is refused with a usable message', () => {
    const git = (...args) => {
      if (args.join(' ').includes('ls-tree')) throw new Error('bad revision');
      return [];
    };
    let msg = '';
    try { predictUpdate(CODE_ROOT, { git }); } catch (e) { msg = e.message; }
    if (!/FETCH_HEAD/.test(msg)) throw new Error(`unhelpful message: ${msg}`);
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length ? 1 : 0;
}

function main(argv) {
  const args = argv.slice(2);
  if (hasFlag(args, '--help')) { console.log(USAGE); return 0; }
  if (hasFlag(args, '--self-test')) return selfTest();

  let result;
  try { result = predictUpdate(); } catch (err) { console.error(err.message); return 2; }

  console.log(hasFlag(args, '--json') ? JSON.stringify(result, null, 2) : render(result));
  return result.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv));
}
