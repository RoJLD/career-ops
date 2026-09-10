#!/usr/bin/env node
/**
 * migrate-bundles.mjs — one-shot move from the flat per-offer layout to the
 * company-grouped one.
 *
 *   output/{NNN}-{company-slug}/vNNN/      ->  output/{company}/{NNN}-{role}/vNNN/
 *
 * WHY THIS IS THE MOST DANGEROUS SCRIPT IN THE REPO
 *
 * `.gitignore:22` is `output/*`. Nothing under it is version controlled, so a
 * bad move is not recoverable with `git checkout` — there is no history to go
 * back to. Everything here follows from that one fact:
 *
 *   - dry run is the DEFAULT; `--apply` is required to touch anything
 *   - the plan is computed and validated in full BEFORE the first rename
 *   - a destination that already exists aborts the whole run, never merges
 *   - re-running after a completed migration is a clean no-op
 *
 * Take a copy of output/ before `--apply` anyway. This script tries hard, but
 * "tries hard" is not a backup.
 *
 * THE MANIFEST IS REWRITTEN LINE BY LINE, ON PURPOSE
 *
 * data/pdf-index.tsv is NOT re-serialized from a parsed structure. The repo's
 * own parser, parsePdfIndex() at find.mjs:88-97, contains
 *
 *     if (!fields[0]?.trim() || !fields[1]) continue;
 *
 * and the manifest carries a row with an EMPTY report number — the generic
 * base CV. Any migration that parsed into a Map and wrote the Map back would
 * delete that row by construction, silently. So this reads the file as lines,
 * touches only cells 1 and 2, and preserves every other byte including
 * comments, blank lines and rows it does not recognise.
 *
 * Run: node migrate-bundles.mjs             (dry run — prints the plan)
 *      node migrate-bundles.mjs --apply     (perform it)
 *      node migrate-bundles.mjs --json
 *      node migrate-bundles.mjs --self-test
 *      node migrate-bundles.mjs --help
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, relative, dirname } from 'path';
import { tmpdir } from 'os';

import { hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { bundleDir } from './bundle.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { resolvePdfIndexPath } from './tracker-utils.mjs';

const USAGE = `Usage:
  node migrate-bundles.mjs             # dry run: print the plan, change nothing
  node migrate-bundles.mjs --apply     # perform the migration
  node migrate-bundles.mjs --json      # machine-readable plan or result
  node migrate-bundles.mjs --self-test # run the in-memory test suite
  node migrate-bundles.mjs --help

output/ is gitignored. Copy it before --apply; there is no git history to
recover from if a move goes wrong.`;

const LEGACY_DIR_RE = /^(\d{3})-/;
const posix = (p) => p.replace(/\\/g, '/');

/**
 * Build the full move plan without touching the filesystem.
 *
 * Returns `{ moves, blocked, alreadyMigrated }`. `blocked` is non-empty when
 * the run must abort: a destination that already exists, or a report whose
 * identity cannot be resolved. Both are refusals, never guesses — merging two
 * bundles or inventing a folder name loses work in a way nothing can undo.
 */
export function planMigration(root) {
  const outputDir = join(root, 'output');
  const moves = [];
  const blocked = [];
  if (!existsSync(outputDir)) return { moves, blocked, alreadyMigrated: 0 };

  let alreadyMigrated = 0;
  const claimed = new Map();

  for (const name of readdirSync(outputDir).sort()) {
    const from = join(outputDir, name);
    if (!statSync(from).isDirectory()) continue;
    const m = name.match(LEGACY_DIR_RE);
    if (!m) { alreadyMigrated += 1; continue; }

    let to;
    try {
      to = bundleDir(m[1], root);
    } catch (err) {
      blocked.push({ bundle: name, reason: err.message });
      continue;
    }

    if (existsSync(to)) {
      blocked.push({ bundle: name, reason: `destination already exists: ${posix(relative(root, to))}` });
      continue;
    }
    const prior = claimed.get(to);
    if (prior) {
      blocked.push({ bundle: name, reason: `two bundles resolve to the same destination as ${prior}` });
      continue;
    }
    claimed.set(to, name);

    moves.push({
      report: m[1],
      from: posix(relative(root, from)),
      to: posix(relative(root, to)),
      fromAbs: from,
      toAbs: to,
    });
  }

  return { moves, blocked, alreadyMigrated };
}

/**
 * Rewrite `output/{old}/…` to `output/{new}/…` inside a text body.
 *
 * Anchored on the trailing slash so `output/021-algoquant/v001/cv.pdf` is
 * rewritten while a bare mention of the folder name in prose is not. Returns
 * the new text and how many substitutions happened.
 */
export function rewritePaths(text, moves) {
  let out = text;
  let count = 0;
  for (const mv of moves) {
    const needle = `${mv.from}/`;
    const parts = out.split(needle);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(`${mv.to}/`);
    }
  }
  return { text: out, count };
}

/**
 * Rewrite the manifest's path cells, preserving every line.
 *
 * Only cells 1 (pdf) and 2 (html) are considered. A row whose report number is
 * empty — the base CV — passes through with its cells rewritten if they match
 * and untouched if they do not. Nothing is dropped, reordered or reformatted.
 */
export function rewriteManifest(text, moves) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let count = 0;
  const out = lines.map((line) => {
    if (!line.trim() || line.startsWith('#')) return line;
    const cells = line.split('\t');
    for (const i of [1, 2]) {
      if (!cells[i]) continue;
      const r = rewritePaths(cells[i], moves);
      if (r.count) { cells[i] = r.text; count += r.count; }
    }
    return cells.join('\t');
  });
  return { text: out.join(eol), count };
}

/** Every reports/*.md that mentions a path being moved. */
function reportsReferencing(root, moves) {
  const dir = join(root, 'reports');
  if (!existsSync(dir)) return [];
  const hits = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const file = join(dir, name);
    const { count } = rewritePaths(readFileSync(file, 'utf8'), moves);
    if (count) hits.push({ file: `reports/${name}`, abs: file, count });
  }
  return hits;
}

/**
 * Compute the plan and, when `apply` is set, perform it.
 * Order matters: directories move first, then the pointers to them. A crash
 * between the two leaves dangling manifest rows, which check-bundles.mjs
 * reports loudly — the recoverable failure. The reverse order would leave
 * rows pointing at paths that do not exist yet AND directories nothing names.
 */
export function migrate(root, { apply = false, manifestPath } = {}) {
  const plan = planMigration(root);
  const indexPath = manifestPath ?? join(root, 'data', 'pdf-index.tsv');
  const manifestExists = existsSync(indexPath);

  const manifestPreview = manifestExists
    ? rewriteManifest(readFileSync(indexPath, 'utf8'), plan.moves)
    : { text: '', count: 0 };
  const reportHits = reportsReferencing(root, plan.moves);

  const result = {
    ...plan,
    manifest: { path: posix(relative(root, indexPath)), rewrites: manifestPreview.count, present: manifestExists },
    reports: reportHits.map(({ file, count }) => ({ file, rewrites: count })),
    applied: false,
  };

  if (!apply) return result;
  if (plan.blocked.length) return result;
  if (!plan.moves.length) { result.applied = true; return result; }

  for (const mv of plan.moves) {
    mkdirSync(dirname(mv.toAbs), { recursive: true });
    renameSync(mv.fromAbs, mv.toAbs);
  }
  if (manifestExists && manifestPreview.count) writeFileSync(indexPath, manifestPreview.text);
  for (const hit of reportHits) {
    writeFileSync(hit.abs, rewritePaths(readFileSync(hit.abs, 'utf8'), plan.moves).text);
  }
  result.applied = true;
  return result;
}

function renderSummary(result, apply) {
  const lines = [];
  if (result.blocked.length) {
    lines.push(`REFUSING TO MIGRATE — ${result.blocked.length} blocker(s):`);
    for (const b of result.blocked) lines.push(`  ${b.bundle}: ${b.reason}`);
    lines.push('');
    lines.push('Nothing was moved. Resolve these by hand, then re-run.');
    return lines.join('\n');
  }
  if (!result.moves.length) {
    lines.push(`Nothing to migrate — ${result.alreadyMigrated} company folder(s) already in the grouped layout.`);
    return lines.join('\n');
  }
  lines.push(`${result.moves.length} bundle(s) to move:`);
  for (const mv of result.moves) lines.push(`  ${mv.from}  ->  ${mv.to}`);
  lines.push('');
  lines.push(`${result.manifest.path}: ${result.manifest.rewrites} path cell(s) rewritten`);
  for (const r of result.reports) lines.push(`${r.file}: ${r.rewrites} reference(s) rewritten`);
  lines.push('');
  lines.push(apply
    ? 'Applied. Verify with: node check-bundles.mjs --summary'
    : 'DRY RUN — nothing changed. Copy output/ somewhere safe, then re-run with --apply.');
  return lines.join('\n');
}

// --- self-test ---------------------------------------------------------------

function selfTest() {
  const root = join(tmpdir(), `migrate-bundles-selftest-${process.pid}`);
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); }
    catch (err) { results.push({ name, ok: false, error: err.message }); }
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
  };

  const report = (company, role) =>
    `# Evaluation: ${company} — ${role}\n\n## Machine Summary\n\n\`\`\`yaml\ncompany: "${company}"\nrole: "${role}"\n\`\`\`\n`;

  const seed = () => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'reports'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'reports', '021-algoquant-2026-09-07.md'),
      `${report('ALGOQUANT', 'DeFi Quant Researcher')}\n**PDF:** output/021-algoquant/v001/cv.pdf\n`);
    writeFileSync(join(root, 'reports', '022-algoquant-2026-09-10.md'),
      `${report('ALGOQUANT', 'Quant Trade Researcher')}\n**PDF:** output/022-algoquant/v001/cv.pdf\n`);
    for (const n of ['021-algoquant', '022-algoquant']) {
      mkdirSync(join(root, 'output', n, 'v001'), { recursive: true });
      writeFileSync(join(root, 'output', n, 'v001', 'cv.pdf'), 'pdf');
    }
    writeFileSync(join(root, 'output', 'cv-someone-base.pdf'), 'pdf');
    writeFileSync(join(root, 'data', 'pdf-index.tsv'),
      '# report\tpdf\thtml\tformat\tdate\n'
      + '021\toutput/021-algoquant/v001/cv.pdf\toutput/021-algoquant/v001/cv.html\ta4\t2026-09-08\n'
      + '\toutput/cv-someone-base.pdf\toutput/cv-someone-base.html\ta4\t2026-08-06\n'
      + '022\toutput/022-algoquant/v001/cv.pdf\toutput/022-algoquant/v001/cv.html\ta4\t2026-09-10\n');
  };

  seed();
  check('the plan groups both ALGOQUANT offers under one company', () => {
    const p = planMigration(root);
    eq(p.moves.length, 2, 'move count');
    eq(p.blocked.length, 0, 'blockers');
    eq(p.moves[0].to, 'output/algoquant/021-defi-quant-researcher', 'first destination');
    eq(p.moves[1].to, 'output/algoquant/022-quant-trade-researcher', 'second destination');
  });

  check('a dry run changes nothing on disk', () => {
    migrate(root, { apply: false });
    if (!existsSync(join(root, 'output', '021-algoquant', 'v001', 'cv.pdf'))) throw new Error('dry run moved a file');
  });

  check('the base-CV row with no report number survives the rewrite', () => {
    const moves = planMigration(root).moves;
    const before = readFileSync(join(root, 'data', 'pdf-index.tsv'), 'utf8');
    const after = rewriteManifest(before, moves).text;
    eq(after.split('\n').length, before.split('\n').length, 'line count');
    if (!after.includes('\toutput/cv-someone-base.pdf\t')) {
      throw new Error('the report-less row was dropped — the find.mjs:88-97 trap');
    }
  });

  check('applying moves the directories and rewrites every pointer', () => {
    const r = migrate(root, { apply: true });
    eq(r.applied, true, 'applied');
    if (existsSync(join(root, 'output', '021-algoquant'))) throw new Error('old dir still present');
    if (!existsSync(join(root, 'output', 'algoquant', '021-defi-quant-researcher', 'v001', 'cv.pdf'))) {
      throw new Error('file did not arrive');
    }
    const tsv = readFileSync(join(root, 'data', 'pdf-index.tsv'), 'utf8');
    if (tsv.includes('output/021-algoquant/')) throw new Error('manifest still points at the old path');
    if (!tsv.includes('output/algoquant/021-defi-quant-researcher/v001/cv.html')) throw new Error('html cell not rewritten');
    const rep = readFileSync(join(root, 'reports', '022-algoquant-2026-09-10.md'), 'utf8');
    if (!rep.includes('**PDF:** output/algoquant/022-quant-trade-researcher/v001/cv.pdf')) {
      throw new Error('report header not rewritten');
    }
  });

  check('re-running after a completed migration is a clean no-op', () => {
    const r = migrate(root, { apply: true });
    eq(r.moves.length, 0, 'no moves');
    eq(r.blocked.length, 0, 'no blockers');
    eq(r.manifest.rewrites, 0, 'no manifest churn');
  });

  check('an occupied destination blocks the WHOLE run, not just that bundle', () => {
    seed();
    mkdirSync(join(root, 'output', 'algoquant', '021-defi-quant-researcher'), { recursive: true });
    const r = migrate(root, { apply: true });
    eq(r.blocked.length, 1, 'blocker count');
    eq(r.applied, false, 'must not apply');
    if (!existsSync(join(root, 'output', '022-algoquant', 'v001', 'cv.pdf'))) {
      throw new Error('an unrelated bundle was moved despite the refusal');
    }
  });

  check('a bundle whose report is missing blocks rather than guessing', () => {
    seed();
    rmSync(join(root, 'reports', '021-algoquant-2026-09-07.md'));
    const r = migrate(root, { apply: true });
    eq(r.blocked.length, 1, 'blocker count');
    eq(r.applied, false, 'must not apply');
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

  // getCareerOpsRoot(), never the script's own directory: the data root can be
  // relocated with CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR or a `.career-ops-data`
  // marker, and output/ + reports/ follow it (DATA_CONTRACT.md). The manifest
  // is resolved through the same pair generate-pdf.mjs and outcome.mjs use, so
  // a CAREER_OPS_PDF_INDEX override is honoured here too rather than silently
  // rewriting a different file than the one the pipeline reads.
  const dataRoot = getCareerOpsRoot();
  const apply = hasFlag(args, '--apply');
  const result = migrate(dataRoot, { apply, manifestPath: resolvePdfIndexPath(resolveTrackerPath(dataRoot)) });

  console.log(hasFlag(args, '--json') ? JSON.stringify(result, null, 2) : renderSummary(result, apply));
  return result.blocked.length ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv));
}
