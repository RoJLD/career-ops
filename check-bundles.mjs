#!/usr/bin/env node
/**
 * check-bundles.mjs — Drift detector for per-offer deliverable folders
 *
 * The "one folder per offer" rule in modes/_custom.md is an instruction to the
 * agent, not something the harness enforces. Instructions decay: a headless
 * batch worker, another CLI, or a PDF generated outside the `pdf` mode can all
 * leave a deliverable loose in output/ without anything complaining.
 *
 * This script is the safety net. It does not prevent drift — it reports it,
 * cheaply and without an LLM, so a stray CV is caught in seconds instead of
 * being discovered months later next to twelve others.
 *
 * Five checks:
 *   1. stray     — an offer deliverable sitting flat in output/ instead of in a bundle
 *   2. dangling  — a data/pdf-index.tsv row pointing at a file that no longer exists
 *   3. misplaced — a deliverable loose in a COMPANY folder, outside any offer
 *   4. empty     — a version folder with no cv.pdf in it
 *   5. legacy    — a bundle still in the flat pre-grouping `output/{NNN}-{slug}/` shape
 *
 * Run: node check-bundles.mjs             (JSON to stdout)
 *      node check-bundles.mjs --summary   (human-readable report)
 *      node check-bundles.mjs --self-test
 *      node check-bundles.mjs --help
 *
 * Exit code is 1 when a stray, dangling or misplaced finding is present, so it
 * can gate a commit or a batch run. `empty` and `legacy` are informational.
 *
 * The directory walk is NOT reimplemented here — it comes from bundle.mjs's
 * listBundles(). That matters: this checker's whole value is being right about
 * the layout, and the previous version kept its own copy of the pattern. A
 * checker that silently stops recognising the shape it guards reports "clean"
 * forever, which is worse than not running at all.
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

import { hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { listBundles } from './bundle.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { resolvePdfIndexPath } from './tracker-utils.mjs';

// The DATA root — see the same note in bundle.mjs.
const CAREER_OPS = getCareerOpsRoot();

const USAGE = `Usage:
  node check-bundles.mjs              # JSON findings to stdout
  node check-bundles.mjs --summary    # human-readable report
  node check-bundles.mjs --self-test  # run the in-memory test suite
  node check-bundles.mjs --help       # print this usage block and exit

Exit 1 when a stray, dangling or misplaced finding is present; 0 otherwise.`;

/**
 * Files allowed to live flat in output/ because they belong to no single offer.
 *
 * This is the one policy knob in this script. Too strict and your own scratch
 * renders are reported every run until you stop reading the output; too loose
 * and a real stray CV hides among them. Edit this list to match how you use
 * output/ — it is read only by this checker and changes nothing else.
 */
export const FLAT_ALLOWLIST = [
  /^\.gitkeep$/,                                  // directory placeholder
  /^_/,                                           // scratch and template test renders
  /-base(-\d{4}-\d{2}-\d{2})?\.(pdf|html)$/,      // the generic, offer-agnostic CV
  /^cv-london-test\./,                            // named template trial render
];

const DELIVERABLE_RE = /\.(pdf|html)$/i;

/** True when a flat file in output/ is expected to be there. */
export function isAllowedFlat(name, allowlist = FLAT_ALLOWLIST) {
  return allowlist.some((pattern) => pattern.test(name));
}

/** Collect every finding. Root-injectable so the self-test needs no real project. */
export function checkBundles(root = CAREER_OPS, { allowlist = FLAT_ALLOWLIST } = {}) {
  const outputDir = join(root, 'output');
  const findings = { stray: [], dangling: [], misplaced: [], empty: [], legacy: [] };

  // 1. Loose deliverables at the top level of output/.
  if (existsSync(outputDir)) {
    for (const name of readdirSync(outputDir).sort()) {
      const full = join(outputDir, name);
      if (statSync(full).isDirectory()) continue;
      if (!DELIVERABLE_RE.test(name)) continue;
      if (isAllowedFlat(name, allowlist)) continue;
      findings.stray.push({ file: `output/${name}` });
    }
  }

  // 2. Manifest rows whose files have gone.
  //
  // Resolved through the same pair generate-pdf.mjs and outcome.mjs use, so a
  // CAREER_OPS_PDF_INDEX override points all three at one file. Hard-coding
  // `join(root, 'data', 'pdf-index.tsv')` here made this checker the odd one
  // out: it would have reported a healthy manifest while the pipeline wrote to
  // a different one. Injected roots still resolve to {root}/data/pdf-index.tsv,
  // which is what the self-test builds.
  const indexPath = resolvePdfIndexPath(resolveTrackerPath(root));
  if (existsSync(indexPath)) {
    const lines = readFileSync(indexPath, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.trim() || line.startsWith('#')) return;
      const cells = line.split('\t');
      for (const cell of [cells[1], cells[2]]) {
        if (cell && !existsSync(join(root, cell))) {
          findings.dangling.push({ line: i + 1, report: cells[0] || null, path: cell });
        }
      }
    });
  }

  // 3. Version folders with no CV in them, and 4. deliverables loose at the
  //    company level. listBundles() owns the walk so the layout is encoded in
  //    ONE place; a second copy of the directory pattern here is how the old
  //    version came to report "clean" for a shape it could no longer see.
  if (existsSync(outputDir)) {
    for (const b of listBundles(root)) {
      if (b.legacy) findings.legacy.push({ bundle: b.bundle });
      const dir = b.company ? join(outputDir, b.company, b.bundle.split('/').pop()) : join(outputDir, b.bundle);
      for (const v of b.versions) {
        if (!existsSync(join(dir, v.version, 'cv.pdf'))) {
          findings.empty.push({ bundle: b.bundle, version: v.version, files: v.files });
        }
      }
    }

    // The company level is new, and it is a new place for a deliverable to
    // hide. FLAT_ALLOWLIST deliberately does NOT apply here: it exists to
    // exempt offer-agnostic artifacts (the base CV, template test renders),
    // and inside a company folder there is no such thing — everything there
    // belongs to one of that employer's offers.
    for (const name of readdirSync(outputDir).sort()) {
      const companyDir = join(outputDir, name);
      if (/^\d{3}-/.test(name) || !statSync(companyDir).isDirectory()) continue;
      for (const inner of readdirSync(companyDir).sort()) {
        if (statSync(join(companyDir, inner)).isDirectory()) continue;
        if (!DELIVERABLE_RE.test(inner)) continue;
        findings.misplaced.push({ file: `output/${name}/${inner}` });
      }
    }
  }

  const blocking = findings.stray.length + findings.dangling.length + findings.misplaced.length;
  return { ok: blocking === 0, blocking, findings };
}

function renderSummary(result) {
  const { findings } = result;
  const lines = [];
  if (findings.stray.length) {
    lines.push(`Stray deliverables in output/ (${findings.stray.length}) — move into a bundle with: node bundle.mjs adopt <report> <file> --as cv.pdf`);
    for (const f of findings.stray) lines.push(`  ${f.file}`);
    lines.push('');
  }
  if (findings.dangling.length) {
    lines.push(`Dangling data/pdf-index.tsv rows (${findings.dangling.length}) — the file is gone:`);
    for (const f of findings.dangling) lines.push(`  line ${f.line}${f.report ? ` (report ${f.report})` : ''}: ${f.path}`);
    lines.push('');
  }
  if (findings.misplaced.length) {
    lines.push(`Deliverables loose in a company folder (${findings.misplaced.length}) — they belong to one of that employer's offers, not to the company:`);
    for (const f of findings.misplaced) lines.push(`  ${f.file}`);
    lines.push('');
  }
  if (findings.empty.length) {
    lines.push(`Version folders without a cv.pdf (${findings.empty.length}, informational):`);
    for (const f of findings.empty) lines.push(`  ${f.bundle}/${f.version} — ${f.files.join(' · ') || '(empty)'}`);
    lines.push('');
  }
  if (findings.legacy.length) {
    lines.push(`Bundles still in the flat pre-grouping layout (${findings.legacy.length}, informational) — migrate with: node migrate-bundles.mjs --apply`);
    for (const f of findings.legacy) lines.push(`  output/${f.bundle}`);
    lines.push('');
  }
  lines.push(result.ok ? 'Bundles are clean.' : `${result.blocking} blocking finding(s).`);
  return lines.join('\n');
}

// --- self-test ---------------------------------------------------------------

function selfTest() {
  const root = join(tmpdir(), `check-bundles-selftest-${process.pid}`);
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); }
    catch (err) { results.push({ name, ok: false, error: err.message }); }
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  };

  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'output', 'qube', '005-quantitative-developer', 'v001'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'output', 'qube', '005-quantitative-developer', 'v001', 'cv.pdf'), 'pdf');
  writeFileSync(join(root, 'data', 'pdf-index.tsv'), '# report\tpdf\thtml\tformat\tdate\n005\toutput/qube/005-quantitative-developer/v001/cv.pdf\t\ta4\t2026-08-15\n');

  check('a tidy project reports nothing', () => {
    const r = checkBundles(root);
    eq(r.ok, true, 'ok');
    eq(r.blocking, 0, 'blocking');
  });

  writeFileSync(join(root, 'output', 'cv-someone-acme-2026-08-15.pdf'), 'pdf');
  check('a loose CV is reported as stray', () => {
    const r = checkBundles(root);
    eq(r.findings.stray.length, 1, 'stray count');
    eq(r.ok, false, 'ok');
  });

  writeFileSync(join(root, 'output', '_scratch.pdf'), 'pdf');
  writeFileSync(join(root, 'output', 'cv-someone-base.html'), 'html');
  check('allowlisted flat files are not stray', () => {
    const r = checkBundles(root);
    eq(r.findings.stray.length, 1, 'still only the real stray');
  });

  writeFileSync(join(root, 'output', 'notes.txt'), 'text');
  check('non-deliverable extensions are ignored', () => {
    eq(checkBundles(root).findings.stray.length, 1, 'stray count unchanged');
  });

  writeFileSync(join(root, 'data', 'pdf-index.tsv'),
    '# report\tpdf\thtml\tformat\tdate\n005\toutput/qube/005-quantitative-developer/v001/cv.pdf\t\ta4\t2026-08-15\n013\toutput/acme/013-gone-role/v001/cv.pdf\t\ta4\t2026-08-15\n');
  check('a vanished manifest target is reported as dangling', () => {
    const r = checkBundles(root);
    eq(r.findings.dangling.length, 1, 'dangling count');
    eq(r.findings.dangling[0].report, '013', 'report number');
  });

  mkdirSync(join(root, 'output', 'qube', '005-quantitative-developer', 'v002'), { recursive: true });
  writeFileSync(join(root, 'output', 'qube', '005-quantitative-developer', 'v002', 'cover.pdf'), 'pdf');
  check('a version folder without cv.pdf is reported as empty', () => {
    const r = checkBundles(root);
    eq(r.findings.empty.length, 1, 'empty count');
    eq(r.findings.empty[0].version, 'v002', 'version');
  });
  check('empty findings do not block', () => {
    rmSync(join(root, 'output', 'cv-someone-acme-2026-08-15.pdf'));
    writeFileSync(join(root, 'data', 'pdf-index.tsv'), '# report\tpdf\thtml\tformat\tdate\n005\toutput/qube/005-quantitative-developer/v001/cv.pdf\t\ta4\t2026-08-15\n');
    const r = checkBundles(root);
    eq(r.findings.empty.length, 1, 'still one empty');
    eq(r.ok, true, 'ok despite the empty version');
  });

  // A custom allowlist REPLACES the default one rather than extending it, so
  // assert on the file under test instead of on a total that also moves.
  check('a custom allowlist is honoured', () => {
    writeFileSync(join(root, 'output', 'keepme.pdf'), 'pdf');
    const named = (r) => r.findings.stray.map((s) => s.file);
    if (!named(checkBundles(root)).includes('output/keepme.pdf')) {
      throw new Error('expected keepme.pdf to be stray under the default allowlist');
    }
    if (named(checkBundles(root, { allowlist: [/^keepme\./] })).includes('output/keepme.pdf')) {
      throw new Error('expected keepme.pdf to be exempt under the custom allowlist');
    }
    rmSync(join(root, 'output', 'keepme.pdf'));
  });

  // --- the company level: new in the grouped layout, new place to hide ---

  writeFileSync(join(root, 'output', 'qube', 'cv-draft.pdf'), 'pdf');
  check('a deliverable loose in a company folder is misplaced, and blocks', () => {
    const r = checkBundles(root);
    eq(r.findings.misplaced.length, 1, 'misplaced count');
    eq(r.findings.misplaced[0].file, 'output/qube/cv-draft.pdf', 'path');
    eq(r.ok, false, 'misplaced must block — it is a real deliverable nobody can attribute');
  });
  check('FLAT_ALLOWLIST does not leak into company folders', () => {
    // `_`-prefixed files are exempt at the output/ root (scratch renders).
    // Inside a company folder nothing is offer-agnostic, so the exemption
    // must NOT apply — otherwise `_draft.pdf` hides forever.
    writeFileSync(join(root, 'output', 'qube', '_draft.pdf'), 'pdf');
    eq(checkBundles(root).findings.misplaced.length, 2, 'both reported');
    rmSync(join(root, 'output', 'qube', '_draft.pdf'));
    rmSync(join(root, 'output', 'qube', 'cv-draft.pdf'));
  });
  check('a non-deliverable in a company folder is ignored', () => {
    writeFileSync(join(root, 'output', 'qube', 'notes.md'), 'text');
    eq(checkBundles(root).findings.misplaced.length, 0, 'md is not a deliverable');
  });

  // --- an unmigrated tree must never read as clean ---

  mkdirSync(join(root, 'output', '099-legacy-flat', 'v001'), { recursive: true });
  writeFileSync(join(root, 'output', '099-legacy-flat', 'v001', 'cv.pdf'), 'pdf');
  check('a flat pre-grouping bundle is reported as legacy', () => {
    const r = checkBundles(root);
    eq(r.findings.legacy.length, 1, 'legacy count');
    eq(r.findings.legacy[0].bundle, '099-legacy-flat', 'legacy name');
  });
  check('legacy findings do not block', () => eq(checkBundles(root).ok, true, 'ok'));
  check('a legacy bundle is still inspected for empty versions', () => {
    mkdirSync(join(root, 'output', '099-legacy-flat', 'v002'), { recursive: true });
    const r = checkBundles(root);
    const legacyEmpty = r.findings.empty.filter((e) => e.bundle === '099-legacy-flat');
    eq(legacyEmpty.length, 1, 'the old shape is checked, not skipped');
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
  if (hasFlag(args, '--help')) { console.log(USAGE); return 0; }
  if (hasFlag(args, '--self-test')) return selfTest();

  const result = checkBundles();
  console.log(hasFlag(args, '--summary') ? renderSummary(result) : JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv));
}
