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

// Accents folded (Orléans → orleans) so cv.md and the payload normalize alike.
const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Whole words of 2+ characters, so "IBM" and "EY" count but "C" and stray years do not.
const STOPWORDS = new Set(['of', 'and', 'the', 'for', 'in', 'at', 'on', 'to', 'de', 'des', 'du', 'la', 'le', 'et', 'en']);
const tokens = (s) => norm(s).split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STOPWORDS.has(w));

/** The English half of cv.md. The French half repeats it and would double every count. */
export function englishHalf(cvText) {
  return cvText.split(/^##\s+Fran/m)[0];
}

/**
 * Content units cv.md declares, keyed by section, as `{ title, items }`.
 *
 * Deliberately coarse: entry TITLES, not bullets. A bullet-level diff would
 * flag every legitimate reframing as an omission and drown the real signal —
 * a whole internship or project missing from the page.
 *
 * A `- **Label:** a, b, c` line is a list (languages, certifications, skills)
 * and keeps its items: the label is a heading tailoring renames freely
 * ("Languages" becomes "Spoken"), the items are what actually reaches the page.
 */
export function cvEntries(cvText) {
  const en = englishHalf(cvText);
  const entries = {};
  let section = null;
  for (const line of en.split(/\r?\n/)) {
    const head = line.match(/^###\s+(.+?)\s*$/);
    if (head) { section = head[1]; entries[section] ??= []; continue; }
    if (!section) continue;
    // Top-level bold entries only (`- **…**`); indented `  - ` lines are bullets.
    const entry = line.match(/^-\s+\*\*(.+?)\*\*(.*)$/);
    if (!entry) continue;
    const title = entry[1].replace(/\s+/g, ' ').trim();
    entries[section].push({ title, items: title.endsWith(':') ? listItems(entry[2]) : [] });
  }
  return entries;
}

/** Entry titles only, keyed by section. */
export function cvUnits(cvText) {
  return Object.fromEntries(Object.entries(cvEntries(cvText)).map(([s, list]) => [s, list.map((e) => e.title)]));
}

const stripParens = (s) => {
  let out = s;
  while (/\([^()]*\)/.test(out)) out = out.replace(/\([^()]*\)/g, ' ');
  return out;
};

/** "French (Native), English (Fluent, TOEIC 880/990)" → ["French", "English"]. */
export function listItems(text) {
  return stripParens(text).split(/[,;|]|\s[—–]\s/).map((s) => s.trim()).filter((s) => norm(s));
}

const MONTH = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?/gi;
const isDateSegment = (s) => /\d{4}/.test(s)
  && !s.replace(MONTH, '').replace(/\d{4}|present|today/gi, '').replace(/[\s–—\-/.]+/g, '');

/**
 * The part of an entry title that names it.
 *
 * cv.md titles read "<dates> — <name>, <location> — <role>". The name is what
 * identifies the entry; the location is shared between entries (one city on
 * two jobs in the regression test) and the role is reworded by tailoring. So: first
 * non-date segment, before its first comma, without parenthesised descriptors
 * and without a "Mid-Studies Project:" style prefix.
 */
export function entryName(title) {
  const named = title.split(/\s+—\s+/).find((s) => !isDateSegment(s)) ?? title;
  return stripParens(named).split(',')[0].replace(/^[^:]*:\s*(?=\S)/, '').trim();
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

/** Payload text, normalized once: whole-word phrases are matched against `text`, tokens against `tokens`. */
export function haystack(strings) {
  const text = norm(strings.join(' | '));
  return { text: ` ${text} `, tokens: new Set(text.split(' ')) };
}

/**
 * The tokens that identify each non-list entry: its name's tokens, minus those
 * another entry's name also carries ("paris" in both "IBM Paris" and "Acme
 * Paris" tells neither apart). An entry whose tokens are all shared keeps them all.
 */
export function entryKeys(entries) {
  const named = entries.filter((e) => !e.items.length);
  const own = new Map(named.map((e) => [e, new Set(tokens(entryName(e.title)))]));
  const df = new Map();
  for (const set of own.values()) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const keys = new Map();
  for (const [e, set] of own) {
    const all = [...set];
    const distinctive = all.filter((t) => df.get(t) === 1);
    keys.set(e, distinctive.length ? distinctive : all.length ? all : tokens(e.title));
  }
  return keys;
}

/**
 * Is this cv.md entry represented anywhere in the payload?
 *
 * Matched on what identifies the entry rather than the whole title, because
 * tailoring rewrites titles freely and legitimately: cv.md's "2021–2026 — ECE
 * Paris, Engineering Cycle" becomes "Engineering Cycle: Major in …" with org
 * "ECE Paris". A whole-string test would call that an omission; a test on every
 * word let a shared city, "France" and "support" carry an omitted entry.
 *
 * A list line is on the page when at least half its items are, whatever the
 * category is called there — and only then: its label alone ("Project
 * Management") proves nothing when the same words title a certification.
 */
export function isRepresented(entry, hay, keys = tokens(entryName(entry.title))) {
  const want = entry.items.length ? entry.items.map(norm) : keys;
  if (!want.length) return true;
  const found = entry.items.length
    ? want.filter((phrase) => hay.text.includes(` ${phrase} `))
    : want.filter((t) => hay.tokens.has(t));
  return found.length / want.length >= 0.5;
}

/** Page count from a PDF, without a parser dependency. */
export function pdfPages(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path).toString('latin1');
  const n = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
  return n || null;
}

export function coverage(payload, cvText, { pdfPath } = {}) {
  const entries = cvEntries(cvText);
  const keys = entryKeys(Object.values(entries).flat());
  const hay = haystack(payloadStrings(payload));
  const sections = {};
  let included = 0;
  let omitted = 0;
  for (const [section, list] of Object.entries(entries)) {
    const kept = [];
    const cut = [];
    for (const e of list) (isRepresented(e, hay, keys.get(e)) ? kept : cut).push(e.title);
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

  // Regressions from a real tailored CV (2026-10-01): an omitted job carried by
  // shared words, languages and certifications kept under other labels.
  const SHARED_CITY = [
    '## English', '', '### Professional Experience', '',
    '- **Jan – Aug 2022 — Acme, Nantes, France — Phone Support Agent**',
    '- **Jun – Sep 2021 — Globex / NOVA, Nantes, France — Sales Representative**',
  ].join('\n');
  check('an entry whose only matches are a shared location and common words is reported', () => {
    const r = coverage({
      experience: [{ company: 'Globex / NOVA', location: 'Nantes, France', role: 'Sales Representative' }],
      projects: [{ title: 'Orbit - Distributed multi-agent framework', description: 'a quantitative decision-support tool' }],
    }, SHARED_CITY);
    eq(r.totals.omitted, 1, 'omitted');
    eq(r.sections['Professional Experience'].cut[0].includes('Acme'), true, 'which');
  });
  check('a project reworded around its name still counts; its sibling does not ride on the shared prefix', () => {
    const r = coverage({ projects: [{ title: 'Volatility Surface Fitting (ENSX x EY) - Project Lead' }], education: [{ org: 'ENSX Paris' }] },
      '## English\n\n### Academic Projects\n\n'
      + '- **Sep 2025 – Feb 2026 — Final-Year Project: Volatility Surface Fitting (ENSX × EY), Paris — Project Lead**\n'
      + '- **Sep 2023 – Feb 2024 — Second-Year Project: Inflation Nowcasting (ENSX)**\n');
    eq(r.sections['Academic Projects'].kept.length, 1, 'kept');
    eq(r.sections['Academic Projects'].cut[0].includes('Nowcasting'), true, 'which');
  });

  const SKILLS = [
    '## English', '', '### Languages & Skills', '',
    '- **Languages:** French (Native), English (Fluent, TOEIC 880/990), German (Conversational)',
    '- **Certifications:** Acme Academy — Project Management, Data Analyst, Cloud Practitioner',
    '- **Project Management:** Agile (Scrum, Kanban), V-Model, Lean Management, Capacity Planning',
  ].join('\n');
  const SKILLS_PAYLOAD = {
    skills: [{ category: 'Spoken', items: ['French (native)', 'English (fluent, TOEIC 880/990)', 'German (conversational)'] }],
    certifications: ['Project Management', 'Data Analyst', 'Cloud Practitioner'].map((title) => ({ title, org: 'Acme Academy' })),
  };
  check('a skill line counts through its items when the payload renames its category', () => {
    const r = coverage(SKILLS_PAYLOAD, SKILLS);
    eq(r.sections['Languages & Skills'].kept.includes('Languages:'), true, 'Languages kept');
  });
  check('certifications count through the payload certifications section', () => {
    const r = coverage(SKILLS_PAYLOAD, SKILLS);
    eq(r.sections['Languages & Skills'].kept.includes('Certifications:'), true, 'Certifications kept');
  });
  check('a skill line whose label survives but whose items do not is reported', () => {
    // "Project Management" is on the page as a certification title; none of the line's items are.
    const r = coverage(SKILLS_PAYLOAD, SKILLS);
    eq(r.sections['Languages & Skills'].cut.join(','), 'Project Management:', 'cut');
  });

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
