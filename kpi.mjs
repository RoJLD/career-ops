#!/usr/bin/env node
/**
 * kpi.mjs — stage-gated KPI board.
 *
 *   node kpi.mjs --summary        human-readable board
 *   node kpi.mjs                  JSON
 *   node kpi.mjs --json           machine-readable JSON (same as no flag; refuses --summary)
 *   node kpi.mjs --threshold 3.8  override the apply-worthy score floor
 *   node kpi.mjs --self-test      run the embedded test suite
 *
 * Read-only. Touches no tracker row, queues nothing, writes nothing.
 *
 * Why this exists alongside stats.mjs: stats.mjs answers "what is in the
 * pipeline", this answers "which numbers are worth reading right now". They
 * share their definitions rather than duplicating them — the funnel counts
 * come from stats.mjs's own computeFunnel(), so the two commands can never
 * disagree about how many applications were ever sent.
 *
 * Tests are embedded rather than placed in tests/: update-system.mjs prunes
 * tests/ and test-fixtures/ of files it does not know about upstream, so a
 * test file there would be deleted by the next update.
 */

import fs from 'node:fs';
import path from 'node:path';

import { computeTrackerStats, computeFunnel, computeScanStats } from './stats.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import {
  parseReportSummary,
  computeKpis,
  formatSummary,
  currentStage,
  rate,
  DEFAULT_THRESHOLD,
  KPI_DEFS,
} from './kpi-core.mjs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const KNOWN_FLAGS = ['--json', '--summary', '--threshold', '--self-test', '--help', '-h'];

// Every path below is user-layer, so all three resolve from the DATA root,
// which getCareerOpsRoot() reads from CAREER_OPS_ROOT / a .career-ops-data
// marker / the code root. Building them from the code root would silently
// read an empty pipeline the moment the user moves their data elsewhere -
// and an empty denominator is exactly what this board locks on, so the
// board would report "not measurable yet" instead of failing loudly.
const DATA_ROOT = getCareerOpsRoot();
const REPORTS_DIR = path.join(DATA_ROOT, 'reports');
const TRACKER_PATH = path.join(DATA_ROOT, 'data', 'applications.md');
const SCAN_HISTORY_PATH = path.join(DATA_ROOT, 'data', 'scan-history.tsv');

/** Read a file, or return '' when it is absent. Missing data is never an error here —
 *  an unreadable file is (EISDIR, EACCES, EBUSY): "nothing" and "cannot see" must not
 *  produce the same board (the cockpit funnel has no other source). */
function readOr(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${filePath}: ${err.message}`);
  }
}

/** Parse every report's Machine Summary. A missing reports/ is an empty pipeline; an unreadable one is an error. */
function loadReports(dir = REPORTS_DIR) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw new Error(`cannot list ${dir}: ${err.message}`);
  }
  return names.map((name) => {
    const parsed = parseReportSummary(readOr(path.join(dir, name)));
    return { file: name, ...parsed };
  });
}

function gather({ threshold = DEFAULT_THRESHOLD } = {}) {
  const racine = fs.statSync(DATA_ROOT, { throwIfNoEntry: false });
  if (!racine?.isDirectory()) throw new Error(`data root is not a directory: ${DATA_ROOT}`);
  const reports = loadReports();
  const trackerText = readOr(TRACKER_PATH);
  const tracker = computeTrackerStats(trackerText);
  const funnel = computeFunnel(tracker.byStatus);
  const scan = computeScanStats(readOr(SCAN_HISTORY_PATH));

  return computeKpis({
    reports,
    funnel,
    scanned: scan.totalRecorded,
    threshold,
  });
}

// ── CLI ─────────────────────────────────────────────────────────────

function usage() {
  console.log(`
kpi.mjs — stage-gated KPI board

  node kpi.mjs --summary          human-readable board
  node kpi.mjs                    JSON
  node kpi.mjs --json             machine-readable JSON (same as no flag; refuses --summary)
  node kpi.mjs --threshold 3.8    override the apply-worthy score floor (default ${DEFAULT_THRESHOLD})
  node kpi.mjs --self-test        run the embedded test suite

A KPI is shown as locked when its denominator is zero, together with what
would unlock it. A rate over a real denominator is shown even at 0% — that
is a measurement; a rate over an empty denominator is not.

Exit codes: 0 board printed · 2 bad argument · 3 data unreadable (root missing,
tracker or reports unreadable) — never a plausible empty board on stdout.
`.trim());
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return usage(), 0;
  if (argv.includes('--self-test')) return selfTest();
  // Un flag inconnu était ignoré en silence (mesuré 2026-09-29) : le cockpit qui appelle
  // `kpi.mjs --json` doit savoir que ce contrat existe, pas tomber dessus par accident.
  const unknown = argv.filter((a, i) => a.startsWith('-') && !KNOWN_FLAGS.includes(a) && argv[i - 1] !== '--threshold');
  if (unknown.length) {
    console.error(`kpi: unrecognized flag(s): ${unknown.join(', ')}. Valid: ${KNOWN_FLAGS.join(', ')}`);
    return 2;
  }
  const json = argv.includes('--json');
  const summary = argv.includes('--summary');
  if (json && summary) { console.error('kpi: --json and --summary are mutually exclusive'); return 2; }

  let threshold = DEFAULT_THRESHOLD;
  const ti = argv.indexOf('--threshold');
  if (ti !== -1) {
    const raw = Number(argv[ti + 1]);
    if (argv[ti + 1] === undefined || !Number.isFinite(raw)) {
      console.error(`kpi: --threshold expects a number, got "${argv[ti + 1] ?? ''}"`);
      return 2;
    }
    threshold = raw;
  }

  let result;
  try {
    result = gather({ threshold });
  } catch (err) {
    console.error(`kpi: ${err.message}`); // exit 3 : « je ne vois rien » n'est jamais rendu comme « rien »
    return 3;
  }

  if (summary) {
    const today = new Date().toISOString().slice(0, 10);
    console.log(formatSummary(result, { today }));
  } else {
    console.log(JSON.stringify(result, null, 2)); // --json et « sans flag » : même sortie
  }
  return 0;
}

// ── Embedded tests ──────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const check = (cond, label) => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}`); }
  };

  console.log('kpi-core self-test\n');

  // -- parseReportSummary -------------------------------------------
  const report = [
    '# Report', 'Some prose mentioning score: 9.9 before the block.',
    '## Machine Summary', '```yaml', 'company: "Qube"', 'score: 4.3',
    'work_auth: "not_needed"', '```',
  ].join('\n');
  const parsed = parseReportSummary(report);
  check(parsed.score === 4.3, 'parses score from the Machine Summary block');
  check(parsed.workAuth === 'not_needed', 'parses work_auth');

  const proseOnly = parseReportSummary('# Report\nscore: 9.9\nwork_auth: "unstated"');
  check(proseOnly.score === null && proseOnly.workAuth === null,
    'ignores score/work_auth outside the Machine Summary block');
  check(parseReportSummary('').score === null, 'empty input yields nulls, not a throw');

  // -- rate ----------------------------------------------------------
  check(rate(4, 20) === 20, 'rate rounds to one decimal');
  check(rate(0, 20) === 0, 'rate of a real zero is 0, not null');
  check(rate(0, 0) === null, 'rate over an empty denominator is null');
  check(rate(1, 3) === 33.3, 'rate keeps one decimal');

  // -- the central distinction ---------------------------------------
  const reports20 = Array.from({ length: 20 }, (_, i) => ({
    score: i < 4 ? 4.2 : 3.5,
    workAuth: i < 6 ? 'not_needed' : 'unstated',
  }));
  const entry = computeKpis({
    reports: reports20,
    funnel: { everApplied: 0, everResponded: 0, everInterview: 0, everOffer: 0 },
    scanned: 2928,
  });
  const byKey = Object.fromEntries(entry.kpis.map((k) => [k.key, k]));

  check(byKey.application_rate.state === 'computable' && byKey.application_rate.value === 0,
    '0 applications over 20 reports is COMPUTABLE at 0% — the informative zero');
  check(byKey.response_rate.state === 'locked' && byKey.response_rate.value === null,
    '0 responses over 0 applications is LOCKED, never 0%');
  check(byKey.response_rate.numerator === null && byKey.response_rate.denominator === null,
    'a locked KPI exposes no numerator or denominator to format');
  check(byKey.offer_rate.state === 'locked',
    'offer rate locks on an empty interview denominator');
  check(byKey.evaluation_yield.value === 20, 'evaluation yield: 4 of 20 above threshold = 20%');
  check(byKey.workauth_resolved.value === 30, 'work-auth resolution: 6 of 20 = 30%');
  check(Math.abs(byKey.scan_yield.value - 0.7) < 0.05, 'scan yield: 20 of 2928 ≈ 0.7%');

  // -- threshold is honoured -----------------------------------------
  const lowered = computeKpis({
    reports: reports20,
    funnel: { everApplied: 0, everResponded: 0, everInterview: 0, everOffer: 0 },
    scanned: 2928,
    threshold: 3.5,
  });
  const loweredYield = lowered.kpis.find((k) => k.key === 'evaluation_yield');
  check(loweredYield.value === 100, 'lowering the threshold moves the evaluation yield');

  // -- stage derivation ----------------------------------------------
  check(entry.stage === 'entry', 'no application → entry stage');
  check(currentStage({ funnel: { everApplied: 3, everInterview: 0 } }) === 'conversion',
    'an application advances the stage to conversion');
  check(currentStage({ funnel: { everApplied: 3, everInterview: 1 } }) === 'process',
    'an interview advances the stage to process');

  // -- small sample ---------------------------------------------------
  const thin = computeKpis({
    reports: [{ score: 4.5, workAuth: 'not_needed' }],
    funnel: { everApplied: 1, everResponded: 0, everInterview: 0, everOffer: 0 },
    scanned: 10,
  });
  const thinResponse = thin.kpis.find((k) => k.key === 'response_rate');
  check(thinResponse.state === 'computable' && thinResponse.smallSample === true,
    'a real but thin denominator is computable AND flagged, not hidden');

  // -- empty world ----------------------------------------------------
  const empty = computeKpis({});
  check(empty.kpis.every((k) => k.state === 'locked'), 'no data at all locks every KPI');
  check(empty.stage === 'entry', 'no data still reports a stage');
  check(empty.kpis.every((k) => typeof k.unlock === 'string' && k.unlock.length > 0),
    'every locked KPI names its unlock condition');

  // -- formatting never renders a locked value ------------------------
  const text = formatSummary(entry, { today: '2026-08-25' });
  check(text.includes('Passage à la candidature : 0%'), 'the informative zero is printed as a value');
  check(!/Taux de réponse\s*:\s*0%/.test(text), 'the locked response rate is never printed as 0%');
  check(text.includes('verrouillé'), 'locked rows are shown, not silently dropped');
  check(text.includes('Prochain déverrouillage'), 'the board names the next unlock');

  // -- registry hygiene -----------------------------------------------
  const keys = KPI_DEFS.map((d) => d.key);
  check(new Set(keys).size === keys.length, 'KPI keys are unique');
  check(KPI_DEFS.every((d) => typeof d.unlock === 'string' && d.unlock.length > 0),
    'every KPI definition ships an unlock condition');

  // -- Contrat CLI : --json explicite, flags inconnus refusés (cockpit L2 en dépend) --
  // Bloc à part : selfTest() déclare déjà `parsed` plus haut.
  {
    const self = fileURLToPath(import.meta.url);
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-selftest-'));
    const run = (...args) => spawnSync(process.execPath, [self, ...args],
      { encoding: 'utf-8', env: { ...process.env, CAREER_OPS_ROOT: emptyRoot } });
    const r = run('--json');
    let sortie = null; try { sortie = JSON.parse(r.stdout); } catch {}
    check(r.status === 0 && sortie !== null, '--json exits 0 and prints parseable JSON');
    check(sortie?.stage === 'entry' && Array.isArray(sortie?.kpis) && sortie.kpis.length === KPI_DEFS.length,
      '--json on an empty root yields the entry stage and one row per KPI_DEF');
    check(sortie?.kpis.every((k) => k.state === 'locked'), '--json on an empty root locks every KPI');
    check(run('--json', '--summary').status === 2, '--json with --summary is refused (exit 2)');
    check(run('--bogus').status === 2, 'an unknown flag is refused (exit 2), never silently ignored');
    check(run('--threshold').status === 2, '--threshold without a value is refused (exit 2)');
    check(run('--threshold', '3.5', '--json').status === 0, '--threshold with a value still works with --json');
    // « rien » ≠ « je ne vois rien » (revue L0, 2026-09-29) : une racine ou un tracker illisible
    // sort en 3 sur stderr — jamais un tableau vide plausible sur stdout.
    const avec = (root) => spawnSync(process.execPath, [self, '--json'],
      { encoding: 'utf-8', env: { ...process.env, CAREER_OPS_ROOT: root } });
    const fichier = path.join(emptyRoot, 'pas-un-dossier');
    fs.writeFileSync(fichier, 'x');
    const r3 = avec(fichier);
    check(r3.status === 3 && r3.stdout === '' && /^kpi: /.test(r3.stderr),
      'a root that is not a directory exits 3 on stderr, nothing on stdout');
    const r4 = avec(path.join(emptyRoot, 'absente'));
    check(r4.status === 3 && r4.stdout === '', 'a missing root exits 3, never a plausible empty board');
    fs.mkdirSync(path.join(emptyRoot, 'data', 'applications.md'), { recursive: true }); // tracker = DOSSIER → EISDIR
    const r5 = run('--json');
    check(r5.status === 3 && r5.stdout === '' && /applications\.md/.test(r5.stderr),
      'an unreadable tracker (EISDIR) exits 3 and names the file');
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
