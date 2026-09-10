#!/usr/bin/env node
/**
 * bundle.mjs — Per-offer deliverable folders for career-ops
 *
 * Places every application deliverable (CV, cover letter, JD) under the
 * EMPLOYER, then the offer, then one subfolder per regeneration:
 *
 *   output/{company-slug}/
 *   └── {NNN}-{role-slug}/
 *       ├── jd.md
 *       ├── v001/{cv.pdf,cv.html,cover.pdf,cover.md}
 *       └── v002/...
 *
 * Company and role come from the report's `## Machine Summary` fence via
 * lib/report-identity.mjs — see that file for why the fence beats both the H1
 * and the filename. The short version: `reports/021-algoquant-….md` and
 * `reports/022-algoquant-….md` reduce to the SAME filename slug, so the old
 * layout produced `output/021-algoquant/` and `output/022-algoquant/`, two
 * folders no one could tell apart without opening them. That is the bug this
 * layout removes.
 *
 * Grouping is not hypothetical: across the 23 reports in this repo, four
 * employers already carry more than one offer (IMC 007/015, Jane Street
 * 010/011, Santander 017/018, ALGOQUANT 021/022).
 *
 * The report number stays in the path because it is the key the tracker,
 * data/pdf-index.tsv and reports/ all join on — and it makes the role folder
 * unique inside a company by construction, so the role slug is free to be
 * short and readable rather than defensive.
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
import { tmpdir } from 'os';

import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { reportIdentity, filenameSlug } from './lib/report-identity.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

// The DATA root, not the code root. reports/ and output/ are user layer and
// follow CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR / a .career-ops-data marker
// (DATA_CONTRACT.md). They coincide in a plain checkout, which is exactly why
// deriving them from this file's own directory reads as correct and is not.
const CAREER_OPS = getCareerOpsRoot();

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
 * LEGACY. The pre-grouping folder slug, read out of the report filename.
 * reports/017-santander-market-risk-2026-08-06.md -> "santander-market-risk"
 *
 * No longer used to BUILD a path — that is bundleDir()'s job via
 * lib/report-identity.mjs. It survives because the migration has to find the
 * old `output/{NNN}-{slug}/` directories, and because it is the honest name
 * for what that string is: a hand-made company+role disambiguator, which is
 * exactly why it cannot serve as a company folder name (it disagrees with the
 * report's own `company:` field for 9 of the 23 reports here).
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

/** Absolute path of the bundle folder for one report: output/{company}/{NNN}-{role}. */
export function bundleDir(report, root = CAREER_OPS) {
  const id = reportIdentity(report, root);
  return join(root, 'output', id.companySlug, `${id.num}-${id.roleSlug}`);
}

/** Absolute path of the PRE-grouping bundle folder. Used only by the migration. */
export function legacyBundleDir(report, root = CAREER_OPS) {
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

/**
 * Every bundle currently on disk, with its versions and their contents.
 *
 * Walks BOTH shapes on purpose. A pre-migration `output/{NNN}-{slug}/` is
 * reported with `legacy: true` rather than skipped, because the failure mode
 * of a filter that matches nothing is an empty list and exit 0 — an
 * unmigrated tree that reads as healthy. Anything that treats this list as
 * "the bundles" should check the flag.
 */
export function listBundles(root = CAREER_OPS) {
  const out = join(root, 'output');
  if (!existsSync(out)) return [];

  const describe = (dir, name, company, legacy) => ({
    bundle: company ? `${company}/${name}` : name,
    company,
    report: name.slice(0, 3),
    legacy,
    versions: listVersions(dir).map((n) => ({
      version: vtag(n),
      files: readdirSync(join(dir, vtag(n))).sort(),
    })),
  });

  const bundles = [];
  for (const entry of readdirSync(out).sort()) {
    const full = join(out, entry);
    if (!statSync(full).isDirectory()) continue;
    if (/^\d{3}-/.test(entry)) { bundles.push(describe(full, entry, null, true)); continue; }
    for (const inner of readdirSync(full).sort()) {
      const innerFull = join(full, inner);
      if (!/^\d{3}-/.test(inner) || !statSync(innerFull).isDirectory()) continue;
      bundles.push(describe(innerFull, inner, entry, false));
    }
  }
  return bundles;
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

  // Fixtures carry a real `## Machine Summary` fence, because that is what
  // bundleDir() now reads. A `'# report'` stub would exercise only the
  // filename fallback and every grouping assertion below would pass for the
  // wrong reason.
  const writeReport = (name, { company, role, h1 = true, fence = true }) => {
    const parts = [];
    if (h1) parts.push(`# Evaluation: ${company} — ${role}\n`);
    if (fence) parts.push(`## Machine Summary\n\n\`\`\`yaml\ncompany: "${company}"\nrole: "${role}"\nscore: 4.0\n\`\`\`\n`);
    if (!h1 && !fence) parts.push('# Notes\n\nHand-written, no structure at all.\n');
    writeFileSync(join(root, 'reports', name), parts.join('\n'));
  };

  writeReport('005-qube-2026-08-06.md', { company: 'Qube Research & Technologies', role: 'Quantitative Developer, Python' });
  writeReport('017-santander-market-risk-2026-08-06.md', { company: 'Santander', role: 'Associate, Traded Market Risk' });
  writeReport('021-algoquant-2026-09-07.md', { company: 'ALGOQUANT', role: 'DeFi Quant Researcher' });
  writeReport('022-algoquant-2026-09-10.md', { company: 'ALGOQUANT', role: 'Quant Trade Researcher' });
  writeReport('030-h1only-2026-09-01.md', { company: 'Acme Capital', role: 'Risk Analyst', fence: false });
  writeReport('031-mystery-2026-09-01.md', { company: '', role: '', h1: false, fence: false });

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

  const rel = (p) => relative(root, p).replace(/\\/g, '/');

  check('bundleDir groups by company and differentiates by role', () =>
    eq(rel(bundleDir('021', root)), 'output/algoquant/021-defi-quant-researcher', 'nested path'));
  check('two offers at one company share a folder but not a bundle', () => {
    eq(rel(bundleDir('022', root)), 'output/algoquant/022-quant-trade-researcher', 'sibling path');
    if (bundleDir('021', root) === bundleDir('022', root)) throw new Error('021 and 022 collided — the exact bug this layout removes');
    eq(dirname(bundleDir('021', root)), dirname(bundleDir('022', root)), 'same company folder');
  });
  check('company slug drops the legal form, keeps the descriptors', () =>
    eq(rel(bundleDir('005', root)), 'output/qube-research-technologies/005-quantitative-developer-python', 'ampersand + comma'));
  check('identity falls back to the H1 when there is no fence', () => {
    const id = reportIdentity('030', root);
    eq(id.source, 'h1', 'source');
    eq(id.companySlug, 'acme-capital', 'company');
    eq(id.roleSlug, 'risk-analyst', 'role');
  });
  check('identity falls back to the filename and does NOT throw', () => {
    const id = reportIdentity('031', root);
    eq(id.source, 'filename', 'source');
    eq(id.companySlug, 'mystery', 'company');
  });
  check('identity still throws on a report that does not exist', () => {
    let threw = false;
    try { reportIdentity('999', root); } catch { threw = true; }
    if (!threw) throw new Error('expected a throw');
  });

  mkdirSync(join(bundleDir('005', root), 'v001'), { recursive: true });
  check('nextVersionPath increments past existing', () =>
    eq(basename(nextVersionPath('005', root)), 'v002', 'second version'));
  check('currentVersionPath finds the latest', () =>
    eq(basename(currentVersionPath('005', root)), 'v001', 'current'));

  mkdirSync(join(bundleDir('021', root), 'v001'), { recursive: true });
  check('two roles at one company do not share a version counter', () =>
    eq(basename(nextVersionPath('022', root)), 'v001', '022 is untouched by 021'));

  mkdirSync(join(bundleDir('005', root), 'v010'), { recursive: true });
  check('version ordering is numeric, not lexicographic', () =>
    eq(basename(nextVersionPath('005', root)), 'v011', 'after v010'));

  // Each adoptFile check seeds its own stray. Chaining them on one file made
  // "refuses to overwrite" pass because the previous check happened to leave
  // the source behind — a pass for the wrong reason.
  const seedStray = (name) => {
    const p = join(root, 'output', name);
    writeFileSync(p, 'pdf');
    return p;
  };

  check('adoptFile moves and renames into the latest version', () => {
    const dest = adoptFile('005', seedStray('stray-a.pdf'), { as: 'cover.pdf', root });
    eq(rel(dest), 'output/qube-research-technologies/005-quantitative-developer-python/v010/cover.pdf', 'full destination');
    if (existsSync(join(root, 'output', 'stray-a.pdf'))) throw new Error('source still present');
  });
  check('adoptFile refuses to overwrite', () => {
    const src = seedStray('stray-b.pdf');
    let threw = false;
    try { adoptFile('005', src, { as: 'cover.pdf', root }); } catch { threw = true; }
    if (!threw) throw new Error('expected a throw');
    if (!existsSync(src)) throw new Error('a refused adopt must leave the source alone');
  });
  check('adoptFile creates v001 when the bundle is empty', () => {
    const dest = adoptFile('017', seedStray('stray-c.pdf'), { as: 'cover.pdf', root });
    eq(rel(dest), 'output/santander/017-associate-traded-market-risk/v001/cover.pdf', 'created first version');
  });

  // Created only now: the version-counter check above needs 022 absent.
  mkdirSync(join(bundleDir('022', root), 'v001'), { recursive: true });
  check('listBundles reports nested bundles with their company', () => {
    const bundles = listBundles(root).filter((b) => !b.legacy);
    eq(bundles.length, 4, 'nested bundle count');
    eq(bundles[0].bundle, 'algoquant/021-defi-quant-researcher', 'first bundle');
    eq(bundles[0].company, 'algoquant', 'company field');
    eq(bundles[0].report, '021', 'report field');
    // The whole point: two ALGOQUANT offers listed as siblings, distinguishable.
    eq(bundles[1].bundle, 'algoquant/022-quant-trade-researcher', 'second bundle');
    eq(bundles.filter((b) => b.company === 'algoquant').length, 2, 'grouped under one company');
  });

  mkdirSync(join(root, 'output', '099-legacy-flat', 'v001'), { recursive: true });
  check('listBundles reports an unmigrated flat bundle instead of hiding it', () => {
    const legacy = listBundles(root).filter((b) => b.legacy);
    eq(legacy.length, 1, 'legacy count');
    eq(legacy[0].bundle, '099-legacy-flat', 'legacy name');
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
        console.log(b.legacy ? `${b.bundle}   [flat — pre-grouping, run: node migrate-bundles.mjs]` : b.bundle);
        for (const v of b.versions) console.log(`  ${v.version}  ${v.files.join(' · ') || '(empty)'}`);
      }
      const legacy = bundles.filter((b) => b.legacy).length;
      if (legacy) console.log(`\n${legacy} bundle(s) still in the flat pre-grouping layout.`);
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
