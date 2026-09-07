#!/usr/bin/env node
/**
 * bundle.mjs — Per-offer deliverable folders for career-ops
 *
 * Places every application deliverable (CV, cover letter, JD) under a folder
 * named after the offer, with one subfolder per regeneration:
 *
 *   output/{NNN}-{company-slug}/
 *   ├── jd.md
 *   ├── v001/{cv.pdf,cv.html,cover.pdf,cover.md}
 *   └── v002/...
 *
 * The company slug is read from the report filename in reports/
 * ({NNN}-{slug}-{YYYY-MM-DD}.md), so it never has to be passed in or guessed,
 * and it stays consistent with the report the tracker links to.
 *
 * This script deliberately does NOT touch data/pdf-index.tsv. That manifest is
 * owned by generate-pdf.mjs, which writes it when given --report; duplicating
 * that here would mean two writers racing over the same file.
 *
 * Typical flow for one tailored CV:
 *
 *   DIR=$(node bundle.mjs next 005)                 # prints output/005-qube/v004
 *   node build-cv-html.mjs payload.json "$DIR/cv.html" "$TEMPLATE"
 *   node generate-pdf.mjs "$DIR/cv.html" "$DIR/cv.pdf" --format=a4 --report=005
 *   node generate-cover-letter.mjs --payload cover.json --report 005
 *   node bundle.mjs adopt 005 output/acme-engineer-cover.pdf --as cover.pdf
 *
 * The last step exists because generate-cover-letter.mjs cannot write into a
 * subfolder: its safeOutputPath() reduces --out to a basename and forces the
 * file into output/. See github.com/santifer/career-ops/issues/2940.
 *
 * Run: node bundle.mjs next <report>              (create + print next version dir)
 *      node bundle.mjs current <report>           (print latest version dir, no create)
 *      node bundle.mjs adopt <report> <file> [--as name]
 *      node bundle.mjs list [--summary]
 *      node bundle.mjs --self-test
 *      node bundle.mjs --help
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync, rmSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage:
  node bundle.mjs next <report>                 # create and print the next version dir
  node bundle.mjs current <report>              # print the latest version dir (no create)
  node bundle.mjs adopt <report> <file> [--as cover.pdf]
                                                # move a stray file into the latest version
  node bundle.mjs list [--summary]              # every bundle and its versions
  node bundle.mjs --self-test                   # run the in-memory test suite
  node bundle.mjs --help                        # print this usage block and exit`;

// --- pure helpers (root-injectable so the self-test needs no real project) ---

/** Zero-pad a report number to the canonical 3 digits. */
export function padReport(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`report must be a number, got "${value}"`);
  return raw.padStart(3, '0');
}

/**
 * Read the company slug out of the report filename.
 * reports/017-santander-market-risk-2026-08-06.md -> "santander-market-risk"
 */
export function resolveSlug(report, root = CAREER_OPS) {
  const num = padReport(report);
  const reportsDir = join(root, 'reports');
  if (!existsSync(reportsDir)) throw new Error(`no reports/ directory under ${root}`);
  const match = readdirSync(reportsDir).find((f) => f.startsWith(`${num}-`) && f.endsWith('.md'));
  if (!match) throw new Error(`no report file found for ${num} in reports/`);
  const slug = match.slice(num.length + 1).replace(/-\d{4}-\d{2}-\d{2}\.md$/, '').replace(/\.md$/, '');
  if (!slug) throw new Error(`could not derive a company slug from "${match}"`);
  return slug;
}

/** Absolute path of the bundle folder for one report. */
export function bundleDir(report, root = CAREER_OPS) {
  return join(root, 'output', `${padReport(report)}-${resolveSlug(report, root)}`);
}

/** Existing version numbers inside a bundle, ascending. */
export function listVersions(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^v\d{3}$/.test(f) && statSync(join(dir, f)).isDirectory())
    .map((f) => Number(f.slice(1)))
    .sort((a, b) => a - b);
}

const vtag = (n) => `v${String(n).padStart(3, '0')}`;

/** Path of the next (not yet existing) version dir. Does not create it. */
export function nextVersionPath(report, root = CAREER_OPS) {
  const dir = bundleDir(report, root);
  const versions = listVersions(dir);
  const next = versions.length ? versions[versions.length - 1] + 1 : 1;
  return join(dir, vtag(next));
}

/** Path of the latest existing version dir, or null when the bundle is empty. */
export function currentVersionPath(report, root = CAREER_OPS) {
  const dir = bundleDir(report, root);
  const versions = listVersions(dir);
  if (!versions.length) return null;
  return join(dir, vtag(versions[versions.length - 1]));
}

/**
 * Move a stray file into the latest version folder, renaming it.
 * Creates v001 when the bundle has no version yet. Never overwrites.
 */
export function adoptFile(report, filePath, { as, root = CAREER_OPS } = {}) {
  if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  let target = currentVersionPath(report, root);
  if (!target) {
    target = join(bundleDir(report, root), vtag(1));
    mkdirSync(target, { recursive: true });
  }
  const destination = join(target, as || basename(filePath));
  if (existsSync(destination)) {
    throw new Error(`refusing to overwrite ${relative(root, destination)} — run "next" for a new version`);
  }
  renameSync(filePath, destination);
  return destination;
}

/** Every bundle currently on disk, with its versions and their contents. */
export function listBundles(root = CAREER_OPS) {
  const out = join(root, 'output');
  if (!existsSync(out)) return [];
  return readdirSync(out)
    .filter((f) => /^\d{3}-/.test(f) && statSync(join(out, f)).isDirectory())
    .sort()
    .map((name) => {
      const dir = join(out, name);
      return {
        bundle: name,
        report: name.slice(0, 3),
        versions: listVersions(dir).map((n) => ({
          version: vtag(n),
          files: readdirSync(join(dir, vtag(n))).sort(),
        })),
      };
    });
}

// --- self-test ---------------------------------------------------------------

function selfTest() {
  const root = join(tmpdir(), `bundle-selftest-${process.pid}`);
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); }
    catch (err) { results.push({ name, ok: false, error: err.message }); }
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  };

  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });
  writeFileSync(join(root, 'reports', '005-qube-2026-08-06.md'), '# report');
  writeFileSync(join(root, 'reports', '017-santander-market-risk-2026-08-06.md'), '# report');

  check('padReport zero-pads', () => eq(padReport('5'), '005', 'padReport'));
  check('padReport rejects non-numeric', () => {
    let threw = false;
    try { padReport('abc'); } catch { threw = true; }
    if (!threw) throw new Error('expected a throw');
  });
  check('resolveSlug reads a single-word slug', () => eq(resolveSlug('005', root), 'qube', 'slug'));
  check('resolveSlug keeps multi-word slugs intact', () =>
    eq(resolveSlug(17, root), 'santander-market-risk', 'slug'));
  check('resolveSlug fails loudly on unknown report', () => {
    let threw = false;
    try { resolveSlug('999', root); } catch { threw = true; }
    if (!threw) throw new Error('expected a throw');
  });
  check('nextVersionPath starts at v001', () =>
    eq(basename(nextVersionPath('005', root)), 'v001', 'first version'));
  check('currentVersionPath is null on an empty bundle', () =>
    eq(currentVersionPath('005', root), null, 'current'));

  mkdirSync(join(root, 'output', '005-qube', 'v001'), { recursive: true });
  check('nextVersionPath increments past existing', () =>
    eq(basename(nextVersionPath('005', root)), 'v002', 'second version'));
  check('currentVersionPath finds the latest', () =>
    eq(basename(currentVersionPath('005', root)), 'v001', 'current'));

  mkdirSync(join(root, 'output', '005-qube', 'v010'), { recursive: true });
  check('version ordering is numeric, not lexicographic', () =>
    eq(basename(nextVersionPath('005', root)), 'v011', 'after v010'));

  writeFileSync(join(root, 'output', 'stray-cover.pdf'), 'pdf');
  check('adoptFile moves and renames into the latest version', () => {
    const dest = adoptFile('005', join(root, 'output', 'stray-cover.pdf'), { as: 'cover.pdf', root });
    eq(basename(dest), 'cover.pdf', 'name');
    eq(basename(dirname(dest)), 'v010', 'landed in latest version');
    if (existsSync(join(root, 'output', 'stray-cover.pdf'))) throw new Error('source still present');
  });
  check('adoptFile refuses to overwrite', () => {
    writeFileSync(join(root, 'output', 'stray-cover.pdf'), 'pdf');
    let threw = false;
    try { adoptFile('005', join(root, 'output', 'stray-cover.pdf'), { as: 'cover.pdf', root }); }
    catch { threw = true; }
    if (!threw) throw new Error('expected a throw');
  });
  check('adoptFile creates v001 when the bundle is empty', () => {
    const dest = adoptFile('017', join(root, 'output', 'stray-cover.pdf'), { as: 'cover.pdf', root });
    eq(basename(dirname(dest)), 'v001', 'created first version');
  });
  check('listBundles reports both bundles', () => {
    const bundles = listBundles(root);
    eq(bundles.length, 2, 'bundle count');
    eq(bundles[0].bundle, '005-qube', 'first bundle');
  });

  rmSync(root, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0 ? 0 : 1;
}

// --- CLI ---------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  if (hasFlag(args, '--help') || args.length === 0) { console.log(USAGE); return 0; }
  if (hasFlag(args, '--self-test')) return selfTest();

  const command = args[0];

  try {
    if (command === 'next') {
      const dir = nextVersionPath(args[1]);
      mkdirSync(dir, { recursive: true });
      console.log(relative(CAREER_OPS, dir).replace(/\\/g, '/'));
      return 0;
    }
    if (command === 'current') {
      const dir = currentVersionPath(args[1]);
      if (!dir) { console.error(`no version folder yet for report ${padReport(args[1])} — run: node bundle.mjs next ${args[1]}`); return 1; }
      console.log(relative(CAREER_OPS, dir).replace(/\\/g, '/'));
      return 0;
    }
    if (command === 'adopt') {
      const dest = adoptFile(args[1], args[2], { as: flagValue(args, '--as') });
      console.log(relative(CAREER_OPS, dest).replace(/\\/g, '/'));
      return 0;
    }
    if (command === 'list') {
      const bundles = listBundles();
      if (!hasFlag(args, '--summary')) { console.log(JSON.stringify({ bundles }, null, 2)); return 0; }
      if (!bundles.length) { console.log('No per-offer bundles in output/ yet.'); return 0; }
      for (const b of bundles) {
        console.log(`${b.bundle}`);
        for (const v of b.versions) console.log(`  ${v.version}  ${v.files.join(' · ') || '(empty)'}`);
      }
      return 0;
    }
    console.error(`Unknown command "${command}"\n\n${USAGE}`);
    return 1;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv));
}
