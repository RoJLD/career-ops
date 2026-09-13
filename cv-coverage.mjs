#!/usr/bin/env node
/**
 * cv-coverage.mjs — what did this tailored CV leave out of cv.md, and on how
 * many pages?
 *
 * WHY
 *
 * A page budget is a real editorial choice, and career-ops had no way to make
 * it one. `london-1p` and `london` differ only in CSS density; what actually
 * fits is decided by the payload the agent authored, and the agent decides that
 * silently. On report 024 the 1-page target cost AGAGI, the HMM bullet, the
 * event study, the Dataiku/BigQuery ETL, ERASMUS and the Google certifications.
 * That was discoverable only by reading the agent's own notes, which is not a
 * control. modes/_custom.md's own rule already says the trim must be declared:
 *
 *   "Both presets render the full CV with no content cuts… If a future CV edit
 *    makes the compact preset overflow to 2 pages, say so rather than silently
 *    trimming content."
 *
 * This is the "say so", computed instead of remembered. It turns 1 / 2 / full
 * pages into an informed choice with a printed cost, which is the whole point:
 * a one-page CV is often the right call for a prop shop, and it should be
 * chosen, not stumbled into.
 *
 * It judges nothing. Omitting content is normal and usually correct — a CV is
 * not an archive. It only refuses to let the omission be invisible.
 *
 * Run: node cv-coverage.mjs <payload.json> [--pdf <file>] [--summary] [--json]
 *      node cv-coverage.mjs <payload.json> --strict     (exit 1 if anything omitted)
 *      node cv-coverage.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

import { hasFlag, flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const USAGE = `Usage:
  node cv-coverage.mjs <payload.json> [--pdf <file>] [--summary|--json] [--strict]
  node cv-coverage.mjs --self-test

Lists what cv.md contains that the tailored payload leaves out, so a page
budget is a declared choice rather than a silent trim. --strict exits 1 when
anything is omitted; the default exit is always 0, because omitting content is
normal.`;

/** The English half of cv.md. The French half repeats it and would double every count. */
export function englishHalf(cvText) {
  return cvText.split(/^##\s+Fran/m)[0];
}

/**
 * Content units cv.md declares, keyed by section.
 *
 * Deliberately coarse: entry TITLES, not bullets. A bullet-level diff would
 * flag every legitimate reframing as an omission and drown the real signal —
 * a whole internship or project missing from the page.
 */
export function cvUnits(cvText) {
  const en = englishHalf(cvText);
  const units = {};
  let section = null;
  for (const line of en.split(/\r?\n/)) {
    const head = line.match(/^###\s+(.+?)\s*$/);
    if (head) { section = head[1]; units[section] ??= []; continue; }
    if (!section) continue;
    // Top-level bold entries only (`- **…**`); indented `  - ` lines are bullets.
    const entry = line.match(/^-\s+\*\*(.+?)\*\*/);
    if (entry) units[section].push(entry[1].replace(/\s+/g, ' ').trim());
  }
  return units;
}

/** Strings the payload actually renders, flattened. */
export function payloadStrings(payload) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(payload);
  return out;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Is this cv.md unit represented anywhere in the payload?
 *
 * Matched on the unit's most distinctive token run rather than the whole title,
 * because tailoring rewrites titles freely and legitimately: cv.md's
 * "2021–2026 — ECE Paris, Engineering Cycle" becomes "Engineering Cycle: Major
 * in …" with org "ECE Paris". A whole-string test would call that an omission.
 */
export function isRepresented(unit, haystack) {
  const words = norm(unit).split(' ').filter((w) => w.length > 3 && !/^\d+$/.test(w));
  if (!words.length) return true;
  const hay = norm(haystack.join(' | '));
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length >= 0.5;
}

/** Page count from a PDF, without a parser dependency. */
export function pdfPages(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path).toString('latin1');
  const n = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
  return n || null;
}

export function coverage(payload, cvText, { pdfPath } = {}) {
  const units = cvUnits(cvText);
  const strings = payloadStrings(payload);
  const sections = {};
  let included = 0;
  let omitted = 0;
  for (const [section, list] of Object.entries(units)) {
    const kept = [];
    const cut = [];
    for (const u of list) (isRepresented(u, strings) ? kept : cut).push(u);
    sections[section] = { kept, cut };
    included += kept.length;
    omitted += cut.length;
  }
  return {
    pages: pdfPath ? pdfPages(pdfPath) : null,
    totals: { declared: included + omitted, included, omitted },
    sections,
  };
}

function render(r) {
  const out = [];
  out.push(`cv.md declares ${r.totals.declared} entries · ${r.totals.included} on the page · ${r.totals.omitted} left out${r.pages ? ` · ${r.pages} page(s)` : ''}`);
  for (const [section, { kept, cut }] of Object.entries(r.sections)) {
    if (!cut.length) { out.push(`\n${section}: all ${kept.length} included`); continue; }
    out.push(`\n${section}: ${kept.length} included, ${cut.length} LEFT OUT`);
    for (const c of cut) out.push(`   - ${c}`);
  }
  out.push('');
  out.push(r.totals.omitted
    ? 'Omitting content is normal. Confirm the list above is what you meant to cut,\nor regenerate against the roomier `london` preset for a 2-page budget.'
    : 'Nothing from cv.md is missing.');
  return out.join('\n');
}

function selfTest() {
  const results = [];
  const check = (n, fn) => { try { fn(); results.push([n, true]); } catch (e) { results.push([n, false, e.message]); } };
  const eq = (a, b, l) => { if (a !== b) throw new Error(`${l}: expected ${b}, got ${a}`); };

  const CV = [
    '# CV', '## English', '', '### Professional Experience', '',
    '- **Feb 2026 — ALTEN Labs — Quantitative Researcher**',
    '  - a bullet that should not be counted as an entry',
    '- **Feb 2025 — Bouygues Telecom — Treasurer**', '',
    '### Personal Projects', '',
    '- **Elysium (Network Infrastructure & Homelab)**',
    '- **AGAGI (Research Sandbox)**', '',
    '## Français', '', '### Expérience professionnelle', '',
    '- **Févr. 2026 — ALTEN Labs — Chercheur**',
  ].join('\n');

  check('the French half is excluded from the counts', () => {
    const u = cvUnits(CV);
    eq(Object.keys(u).join(','), 'Professional Experience,Personal Projects', 'sections');
  });
  check('indented bullets are not counted as entries', () =>
    eq(cvUnits(CV)['Professional Experience'].length, 2, 'entries'));
  check('an omitted project is reported', () => {
    const r = coverage({ experience: [{ company: 'ALTEN Labs' }, { company: 'Bouygues Telecom' }], projects: [{ name: 'Elysium Homelab' }] }, CV);
    eq(r.totals.omitted, 1, 'omitted');
    eq(r.sections['Personal Projects'].cut[0], 'AGAGI (Research Sandbox)', 'which');
  });
  check('a legitimately reworded title still counts as included', () => {
    // Tailoring rewrites titles; a whole-string test would call this a cut.
    const r = coverage({ education: [{ title: 'Engineering Cycle: Major in Finance', org: 'ECE Paris' }] },
      '## English\n\n### Education\n\n- **2021–2026 — ECE Paris, Engineering Cycle**\n');
    eq(r.totals.omitted, 0, 'omitted');
  });
  check('a full payload omits nothing', () => {
    const r = coverage({ a: ['ALTEN Labs', 'Bouygues Telecom', 'Elysium Homelab', 'AGAGI Research Sandbox'] }, CV);
    eq(r.totals.omitted, 0, 'omitted');
  });
  check('a missing PDF yields null pages, not a crash', () =>
    eq(pdfPages('does-not-exist.pdf'), null, 'pages'));

  for (const [n, ok, err] of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : ` — ${err}`}`);
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed ? 1 : 0;
}

function main(argv) {
  const args = argv.slice(2);
  if (hasFlag(args, '--help') || !args.length) { console.log(USAGE); return 0; }
  if (hasFlag(args, '--self-test')) return selfTest();

  const payloadPath = args.find((a) => !a.startsWith('--'));
  if (!payloadPath || !existsSync(payloadPath)) { console.error(`payload not found: ${payloadPath}`); return 2; }
  const cvPath = `${getCareerOpsRoot()}/cv.md`;
  if (!existsSync(cvPath)) { console.error('cv.md not found'); return 2; }

  const r = coverage(
    JSON.parse(readFileSync(payloadPath, 'utf8')),
    readFileSync(cvPath, 'utf8'),
    { pdfPath: flagValue(args, '--pdf') },
  );
  console.log(hasFlag(args, '--json') ? JSON.stringify(r, null, 2) : render(r));
  return hasFlag(args, '--strict') && r.totals.omitted ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exit(main(process.argv));
