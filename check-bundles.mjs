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
 * Three checks:
 *   1. stray     — an offer deliverable sitting flat in output/ instead of in a bundle
 *   2. dangling  — a data/pdf-index.tsv row pointing at a file that no longer exists
 *   3. empty     — a version folder with no cv.pdf in it
 *
 * Run: node check-bundles.mjs             (JSON to stdout)
 *      node check-bundles.mjs --summary   (human-readable report)
 *      node check-bundles.mjs --self-test
 *      node check-bundles.mjs --help
 *
 * Exit code is 1 when any stray or dangling finding is present, so it can gate
 * a commit or a batch run. `empty` findings are informational and do not fail.
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';

import { hasFlag } from './lib/cli-flags.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage:
  node check-bundles.mjs              # JSON findings to stdout
  node check-bundles.mjs --summary    # human-readable report
  node check-bundles.mjs --self-test  # run the in-memory test suite
  node check-bundles.mjs --help       # print this usage block and exit

Exit 1 when a stray or dangling finding is present; 0 otherwise.`;

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
  const findings = { stray: [], dangling: [], empty: [] };

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
  const indexPath = join(root, 'data', 'pdf-index.tsv');
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

  // 3. Version folders with no CV in them.
  if (existsSync(outputDir)) {
    for (const name of readdirSync(outputDir).sort()) {
      const bundle = join(outputDir, name);
      if (!/^\d{3}-/.test(name) || !statSync(bundle).isDirectory()) continue;
      for (const version of readdirSync(bundle).sort()) {
        const vdir = join(bundle, version);
        if (!/^v\d{3}$/.test(version) || !statSync(vdir).isDirectory()) continue;
        if (!existsSync(join(vdir, 'cv.pdf'))) {
          findings.empty.push({ bundle: name, version, files: readdirSync(vdir).sort() });
        }
      }
    }
  }

  const blocking = findings.stray.length + findings.dangling.length;
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
  if (findings.empty.length) {
    lines.push(`Version folders without a cv.pdf (${findings.empty.length}, informational):`);
    for (const f of findings.empty) lines.push(`  ${f.bundle}/${f.version} — ${f.files.join(' · ') || '(empty)'}`);
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
  mkdirSync(join(root, 'output', '005-qube', 'v001'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'output', '005-qube', 'v001', 'cv.pdf'), 'pdf');
  writeFileSync(join(root, 'data', 'pdf-index.tsv'), '# report\tpdf\thtml\tformat\tdate\n005\toutput/005-qube/v001/cv.pdf\t\ta4\t2026-08-15\n');

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
    '# report\tpdf\thtml\tformat\tdate\n005\toutput/005-qube/v001/cv.pdf\t\ta4\t2026-08-15\n013\toutput/013-gone/v001/cv.pdf\t\ta4\t2026-08-15\n');
  check('a vanished manifest target is reported as dangling', () => {
    const r = checkBundles(root);
    eq(r.findings.dangling.length, 1, 'dangling count');
    eq(r.findings.dangling[0].report, '013', 'report number');
  });

  mkdirSync(join(root, 'output', '005-qube', 'v002'), { recursive: true });
  writeFileSync(join(root, 'output', '005-qube', 'v002', 'cover.pdf'), 'pdf');
  check('a version folder without cv.pdf is reported as empty', () => {
    const r = checkBundles(root);
    eq(r.findings.empty.length, 1, 'empty count');
    eq(r.findings.empty[0].version, 'v002', 'version');
  });
  check('empty findings do not block', () => {
    rmSync(join(root, 'output', 'cv-someone-acme-2026-08-15.pdf'));
    writeFileSync(join(root, 'data', 'pdf-index.tsv'), '# report\tpdf\thtml\tformat\tdate\n005\toutput/005-qube/v001/cv.pdf\t\ta4\t2026-08-15\n');
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
