#!/usr/bin/env node
/**
 * watch.mjs — pipeline watcher: surfaces work already paid for and going stale.
 *
 * Zero-token, scheduled check across three signals: job postings that died
 * (via check-liveness.mjs), follow-ups that came due (via
 * followup-cadence.mjs), and high-scoring evaluations left unapplied. Every
 * finding is de-duplicated against what is already pending in the agent
 * inbox, then appended there — the same inbox the AI assistant drains at the
 * start of each session. See `.planning/watch-design.md` for the design.
 *
 * Design note: this script writes to ONE file, `data/agent-inbox.md`, and
 * only through `agent-inbox.mjs add`. It never touches the tracker, never
 * sends anything, never submits an application. A liveness check that fails,
 * times out, or returns unrecognized output is treated as `uncertain` for
 * every URL — a `dead` finding is only ever emitted on an explicit `expired`
 * status, because a false "this posting is dead" makes the user abandon a
 * live job opportunity.
 *
 * Run: node watch.mjs                  (check, write findings to the inbox, print JSON)
 *      node watch.mjs --dry-run        (check, print JSON, write nothing)
 *      node watch.mjs --summary        (human-readable output instead of JSON)
 *      node watch.mjs --self-test
 *      node watch.mjs --help
 */
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { hasFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { analyzeFromContent } from './followup-cadence.mjs';
import { findingKey, parseInboxPending, filterAlreadyQueued, detectStaleEvaluations, parseLivenessOutput, detectDeadPostings, suppressRedundant, detectFollowupsDue, reportNumberFromCell, collectFindings } from './watch-core.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

// CAREER_OPS is the CODE root: it resolves sibling scripts and is the cwd we
// spawn them from. DATA_ROOT is the DATA root, which getCareerOpsRoot()
// resolves from CAREER_OPS_ROOT / a .career-ops-data marker / the code root.
// They coincide by default and diverge the moment data lives elsewhere, so a
// user-layer path must never be built from CAREER_OPS.
const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const URL_HEADER_RE = /^\*\*URL:\*\*\s*(\S+)/m;

const USAGE = `watch.mjs — pipeline watcher: dead postings, due follow-ups, stale evaluations

Usage:
  node watch.mjs                  Check, write findings to the agent inbox, print JSON
  node watch.mjs --dry-run        Check, print JSON, write nothing
  node watch.mjs --summary        Human-readable output instead of JSON
  node watch.mjs --self-test      Run the embedded test suite
  node watch.mjs --help           Show this help
`;

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: err.message }); }
};
const eq = (a, b, label) => { if (a !== b) throw new Error(`${label}: attendu ${b}, obtenu ${a}`); };

function selfTest() {
  const row = (over = {}) => ({
    date: '2026-08-06', company: 'Qube', status: 'Evaluated',
    score: '4.3/5', report: '[005](../reports/005-qube-2026-08-06.md)', ...over,
  });
  const OPTS = { today: '2026-08-17', staleDays: 7, minScore: 4.0 };

  check('findingKey encode type et rapport', () =>
    eq(findingKey({ type: 'stale', report: '005' }), 'watch:stale:005', 'key'));

  check('parseInboxPending ne retient que les items non cochés', () => {
    const md = [
      '- [ ] 2026-08-17 09:30 — [watch:stale:005] Qube dort',
      '- [x] 2026-08-16 18:05 — [watch:dead:014] DRW → result: retiré',
    ].join('\n');
    const pending = parseInboxPending(md);
    eq(pending.length, 1, 'nombre');
    eq(pending[0].includes('[watch:stale:005]'), true, 'contenu');
  });

  check('filterAlreadyQueued écarte une clé pendante, laisse passer une résolue', () => {
    const md = '- [ ] 2026-08-17 09:30 — [watch:stale:005] Qube dort\n- [x] 2026-08-16 18:05 — [watch:dead:014] DRW';
    const pending = parseInboxPending(md);
    const fresh = filterAlreadyQueued(
      [{ type: 'stale', report: '005' }, { type: 'dead', report: '014' }],
      pending
    );
    eq(fresh.length, 1, 'un seul nouveau');
    eq(fresh[0].type, 'dead', 'le résolu peut re-déclencher');
  });

  check('filterAlreadyQueued reconnaît une clé à 4 chiffres (rapport ≥ 1000)', () => {
    // findingKey ne fait que padStart(3, '0') — un rapport 1024 émet
    // watch:stale:1024, jamais watch:stale:024. La regex de lecture doit
    // accepter 3 chiffres OU PLUS, sinon ce constat est réinjecté chaque jour.
    const pending = parseInboxPending('- [ ] 2026-08-17 09:30 — [watch:stale:1024] Qube dort');
    const fresh = filterAlreadyQueued([{ type: 'stale', report: '1024' }], pending);
    eq(fresh.length, 0, 'déjà pendant, donc écarté');
  });

  check('stale signale une évaluation ancienne au-dessus du seuil', () => {
    const f = detectStaleEvaluations([row()], OPTS);
    eq(f.length, 1, 'nombre'); eq(f[0].report, '005', 'rapport'); eq(f[0].type, 'stale', 'type');
  });
  check('stale ignore une évaluation récente', () =>
    eq(detectStaleEvaluations([row({ date: '2026-08-15' })], OPTS).length, 0, 'nombre'));
  check('stale ignore un score sous le seuil', () =>
    eq(detectStaleEvaluations([row({ score: '3.9/5' })], OPTS).length, 0, 'nombre'));
  // Bornes exactes : sur les données réelles de l'utilisateur, 3 des 4 lignes
  // stale sont à un score de PILE 4.0/5. Un flip accidentel de `<` en `<=`
  // (côté âge) ou `<` en `>` (côté score) supprimerait la quasi-totalité de
  // la fonctionnalité en silence — d'où ces deux tests de bornes séparés des
  // cas généraux ci-dessus.
  check('stale n_écarte PAS une évaluation dont l_âge est exactement au seuil', () => {
    // today = 2026-08-17, staleDays = 7 → date = 2026-08-10 donne age === 7.
    eq(detectStaleEvaluations([row({ date: '2026-08-10' })], OPTS).length, 0, 'nombre');
  });
  check('stale signale une évaluation dont le score est exactement au seuil', () => {
    const f = detectStaleEvaluations([row({ score: '4.0/5' })], OPTS);
    eq(f.length, 1, 'nombre');
  });
  check('stale ignore les scores sentinelles', () => {
    for (const s of ['N/A', '—', '-']) {
      eq(detectStaleEvaluations([row({ score: s })], OPTS).length, 0, `sentinelle ${s}`);
    }
  });
  check('stale ignore les états non-Evaluated', () => {
    for (const st of ['Applied', 'Rejected', 'Discarded', 'SKIP', 'Hired']) {
      eq(detectStaleEvaluations([row({ status: st })], OPTS).length, 0, `état ${st}`);
    }
  });

  const LIVENESS_STDOUT = [
    'Checking 2 URL(s)... (headed fallback on challenge)',
    '',
    '✅ active     (api) https://boards.example.com/a',
    '❌ expired          https://boards.example.com/b',
    '           posting removed',
    '',
    'Results: 1 active  1 expired  0 uncertain  (1 via API, no browser)',
  ].join('\n');

  check('parseLivenessOutput lit statut et URL', () => {
    const m = parseLivenessOutput(LIVENESS_STDOUT);
    eq(m.get('https://boards.example.com/a'), 'active', 'a');
    eq(m.get('https://boards.example.com/b'), 'expired', 'b');
    eq(m.size, 2, 'taille');
  });

  const MIXED_LIVENESS_STDOUT = [
    'Checking 3 URL(s)... (headed fallback on challenge)',
    '',
    '✅ active     (api) https://boards.example.com/a',
    '❌ expired          https://boards.example.com/b',
    '           posting removed',
    '⚠️ uncertain        https://boards.example.com/c',
    '           content present but no visible apply control found',
    '',
    'Results: 1 active  1 expired  1 uncertain  (1 via API, no browser)',
  ].join('\n');

  // Régression : un lot mixte (le cas réel — une seule URL incertaine sur vingt
  // faisait autrefois échouer check-liveness.mjs avec exit non-zéro, et le
  // catch de runLiveness jetait tout err.stdout, effaçant même les statuts
  // actifs/expirés lus sans problème). La ligne `Results:` ne doit produire
  // aucune 4e entrée.
  check('parseLivenessOutput lit un lot mixte actif/expiré/incertain, Results ignorée', () => {
    const m = parseLivenessOutput(MIXED_LIVENESS_STDOUT);
    eq(m.get('https://boards.example.com/a'), 'active', 'a');
    eq(m.get('https://boards.example.com/b'), 'expired', 'b');
    eq(m.get('https://boards.example.com/c'), 'uncertain', 'c');
    eq(m.size, 3, 'aucune entrée fantôme depuis la ligne Results');
  });

  check('dead est émis sur expired', () => {
    const rows = [row({ report: '[014](../reports/014-drw-2026-08-06.md)', company: 'DRW' })];
    const f = detectDeadPostings(rows, new Map([['u14', 'expired']]), new Map([['014', 'u14']]));
    eq(f.length, 1, 'nombre'); eq(f[0].type, 'dead', 'type');
  });

  check('dead n_est jamais émis sur uncertain', () => {
    const rows = [row({ report: '[014](../reports/014-drw-2026-08-06.md)' })];
    eq(detectDeadPostings(rows, new Map([['u14', 'uncertain']]), new Map([['014', 'u14']])).length, 0, 'nombre');
  });

  check('dead supprime stale sur la même ligne', () => {
    const out = suppressRedundant([
      { type: 'stale', report: '014', company: 'DRW', detail: 's' },
      { type: 'dead', report: '014', company: 'DRW', detail: 'd' },
    ]);
    eq(out.length, 1, 'nombre'); eq(out[0].type, 'dead', 'dead gagne');
  });

  const entry = (over = {}) => ({
    num: 7, company: 'IMC', role: 'Graduate QR', status: 'Applied',
    urgency: 'overdue', reportPath: 'reports/007-imc-2026-08-06.md', daysUntilNext: -3, ...over,
  });

  check('followup retient overdue et urgent', () => {
    const f = detectFollowupsDue([entry(), entry({ urgency: 'urgent', num: 8 })]);
    eq(f.length, 2, 'nombre'); eq(f[0].type, 'followup', 'type');
  });
  check('followup ignore waiting, cold et retired', () => {
    for (const u of ['waiting', 'cold', 'retired']) {
      eq(detectFollowupsDue([entry({ urgency: u })]).length, 0, `urgence ${u}`);
    }
  });
  check('followup tire le numéro de rapport du reportPath', () =>
    eq(detectFollowupsDue([entry()])[0].report, '007', 'rapport'));

  check('collectFindings assemble, supprime la redondance et déduplique', () => {
    const rows = [
      row(),                                                                    // 005 stale
      row({ report: '[014](../reports/014-drw-2026-08-06.md)', company: 'DRW' }), // 014 dead
    ];
    const out = collectFindings({
      rows,
      livenessByUrl: new Map([['u14', 'expired']]),
      urlByReport: new Map([['014', 'u14']]),
      cadenceEntries: [],
      pendingTexts: [],
      opts: OPTS,
    });
    eq(out.length, 2, 'un stale + un dead');
    eq(out.filter(f => f.type === 'stale' && f.report === '014').length, 0, 'stale 014 supprimé');
  });

  check('collectFindings écarte ce qui est déjà pendant', () => {
    const out = collectFindings({
      rows: [row()], livenessByUrl: new Map(), urlByReport: new Map(), cadenceEntries: [],
      pendingTexts: ['- [ ] 2026-08-17 09:30 — [watch:stale:005] déjà signalé'],
      opts: OPTS,
    });
    eq(out.length, 0, 'rien de neuf');
  });

  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passés`);
  return failed === 0 ? 0 : 1;
}

/**
 * URL de chaque rapport, lue dans son en-tête.
 *
 * Un rapport sans fichier sur disque ou sans en-tête `**URL:**` est ignoré —
 * c'est la conservatisme voulu du §6 du design (mieux vaut rater un constat
 * `dead` que d'en inventer un). Mais silencieux, cet abandon est dangereux :
 * si les en-têtes URL régressent un jour, la détection `dead` retombe à zéro
 * constat sans que rien ne le signale. `skipped` porte donc les numéros de
 * rapport écartés ici, pour que l'appelant les compte et les affiche.
 */
function buildUrlByReport(reports) {
  const map = new Map();
  const skipped = [];
  for (const { report, path } of reports) {
    if (!existsSync(path)) { skipped.push(report); continue; }
    const m = readFileSync(path, 'utf8').match(URL_HEADER_RE);
    if (m) map.set(report, m[1]);
    else skipped.push(report);
  }
  return { map, skipped };
}

/**
 * Vivacité via check-liveness.mjs. check-liveness.mjs exits non-zero as soon
 * as ONE url is `expired`/`uncertain` — a routine outcome, not a broken run —
 * so a thrown error's `err.stdout` is parsed exactly like a clean exit's
 * stdout. Only stdout that yields nothing parseable (subprocess missing,
 * timeout, output the parser doesn't recognise) falls back to "everything
 * uncertain"; a `dead` finding still requires an explicit `expired` status.
 */
function runLiveness(urls) {
  if (!urls.length) return new Map();
  let stdout = '';
  let thrown = null;
  try {
    stdout = execFileSync('node', ['check-liveness.mjs', ...urls],
      { cwd: CAREER_OPS, encoding: 'utf8', timeout: 300000 });
  } catch (err) {
    thrown = err;
    stdout = err.stdout != null ? String(err.stdout) : '';
  }
  const parsed = parseLivenessOutput(stdout);
  if (parsed.size === 0) {
    const reason = thrown ? ` (${thrown.message})` : '';
    console.error(`watch: sortie de check-liveness non reconnue${reason} — tout traité comme uncertain`);
    return new Map();
  }
  return parsed;
}

const TODAY = () => new Date().toISOString().slice(0, 10);

/** Écrit un constat dans l'inbox. Échec = exit 1 : un constat perdu est pire qu'un run raté. */
function queueFinding(finding) {
  const text = `[${findingKey(finding)}] ${finding.detail}`;
  try {
    execFileSync('node', ['agent-inbox.mjs', 'add', text], { cwd: CAREER_OPS, encoding: 'utf8' });
    return true;
  } catch (err) {
    console.error(`watch: écriture inbox impossible pour ${findingKey(finding)} — ${err.message}`);
    return false;
  }
}

function main(argv) {
  const args = argv.slice(2);
  if (hasFlag(args, '--help')) { console.log(USAGE); return 0; }
  if (hasFlag(args, '--self-test')) return selfTest();

  const appsPath = join(DATA_ROOT, 'data', 'applications.md');
  if (!existsSync(appsPath)) { console.error(`watch: tracker introuvable (${appsPath})`); return 1; }
  const trackerContent = readFileSync(appsPath, 'utf8');

  let rows;
  try {
    const lines = trackerContent.split(/\r?\n/);
    const colmap = resolveColumns(lines);
    rows = lines.map(l => parseTrackerRow(l, colmap)).filter(Boolean);
  } catch (err) {
    console.error(`watch: tracker illisible — ${err.message}`);
    return 1;
  }
  if (!rows.length) { console.error('watch: aucune ligne exploitable dans le tracker'); return 1; }

  // Un nom de rapport porte un slug et une date (005-qube-2026-08-06.md) :
  // on le résout par préfixe plutôt qu'en le reconstruisant.
  const reportFiles = readdirSync(join(DATA_ROOT, 'reports')).filter(f => f.endsWith('.md'));
  const evaluatedReportNumbers = rows
    .filter(r => r.status === 'Evaluated')
    .map(r => reportNumberFromCell(r.report))
    .filter(Boolean);

  // Deux façons distinctes de perdre un rapport avant même de tenter la
  // vivacité : le fichier n'existe pas sur disque, ou (une fois lu) il n'a
  // pas d'en-tête **URL:**. Les deux sont comptées ensemble (spec §6) : dans
  // les deux cas la ligne devient invisible pour `dead` sans qu'on le sache.
  const missingOnDisk = [];
  const resolved = [];
  for (const report of evaluatedReportNumbers) {
    const file = reportFiles.find(f => f.startsWith(`${report}-`));
    if (file) resolved.push({ report, path: join(DATA_ROOT, 'reports', file) });
    else missingOnDisk.push(report);
  }

  const { map: urlByReport, skipped: missingUrlHeader } = buildUrlByReport(resolved);
  const skippedReports = [...missingOnDisk, ...missingUrlHeader].sort();
  const livenessByUrl = runLiveness([...urlByReport.values()]);

  const followupsPath = join(DATA_ROOT, 'data', 'follow-ups.md');
  const followupsContent = existsSync(followupsPath) ? readFileSync(followupsPath, 'utf8') : '';
  const cadence = analyzeFromContent(trackerContent, followupsContent);

  const inboxPath = join(DATA_ROOT, 'data', 'agent-inbox.md');
  const pendingTexts = parseInboxPending(existsSync(inboxPath) ? readFileSync(inboxPath, 'utf8') : '');

  const findings = collectFindings({
    rows, livenessByUrl, urlByReport,
    cadenceEntries: cadence.entries ?? [],
    pendingTexts,
    opts: { today: TODAY(), staleDays: 7, minScore: 4.0 },
  });

  const dryRun = hasFlag(args, '--dry-run');
  let added = 0, failed = 0;
  if (!dryRun) for (const f of findings) { if (queueFinding(f)) added++; else failed++; }

  const result = {
    checked: rows.length, liveness: livenessByUrl.size, findings, added, dryRun,
    skippedForUrl: skippedReports.length,
    skippedForUrlReports: skippedReports,
  };
  if (hasFlag(args, '--summary')) {
    console.log(`Tracker : ${result.checked} lignes · vivacité : ${result.liveness} vérifiées`);
    if (skippedReports.length) {
      console.log(`Ignorés faute d'URL résolvable : ${skippedReports.length} rapport(s) (${skippedReports.join(', ')})`);
    }
    if (!findings.length) console.log('Aucun constat nouveau.');
    for (const f of findings) console.log(`  [${findingKey(f)}] ${f.detail}`);
    console.log(dryRun ? '\n(dry-run — rien écrit)' : `\n${added} item(s) ajouté(s) à l'inbox.`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return failed > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv));
