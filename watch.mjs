#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { hasFlag } from './lib/cli-flags.mjs';
import { findingKey, parseInboxPending, filterAlreadyQueued, detectStaleEvaluations, parseLivenessOutput, detectDeadPostings, suppressRedundant } from './watch-core.mjs';

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

  check('stale signale une évaluation ancienne au-dessus du seuil', () => {
    const f = detectStaleEvaluations([row()], OPTS);
    eq(f.length, 1, 'nombre'); eq(f[0].report, '005', 'rapport'); eq(f[0].type, 'stale', 'type');
  });
  check('stale ignore une évaluation récente', () =>
    eq(detectStaleEvaluations([row({ date: '2026-08-15' })], OPTS).length, 0, 'nombre'));
  check('stale ignore un score sous le seuil', () =>
    eq(detectStaleEvaluations([row({ score: '3.9/5' })], OPTS).length, 0, 'nombre'));
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

  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passés`);
  return failed === 0 ? 0 : 1;
}

function main(argv) {
  const args = argv.slice(2);
  if (hasFlag(args, '--self-test')) return selfTest();
  console.log('watch: pas encore implémenté');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
