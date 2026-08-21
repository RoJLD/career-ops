#!/usr/bin/env node
/**
 * check-archetypes.mjs — Archetype vocabulary validator for career-ops
 *
 * Evaluation reports record `archetype:` in their Machine Summary as free text.
 * Measured 2026-08-21: 20 distinct labels across 20 reports — every one unique,
 * only one using a canonical name verbatim. `analyze-patterns` can never group
 * by archetype when no two reports share a key.
 *
 * The canonical list is NOT invented here. It already exists, machine-readable,
 * in config/profile.yml under target_roles.archetypes[].name. This script reads
 * that list and reports how each report's label relates to it.
 *
 *   canonical — verbatim one (or more) of the declared archetype names
 *   mappable  — resolves to at least one declared archetype, but not verbatim
 *   unmapped  — resolves to none: the role sits outside declared targeting
 *
 * `unmapped` is the signal worth having. Three trader roles were evaluated;
 * "Quantitative Trader" is declared nowhere in the profile, and those three
 * scored 3.3, 2.6 and 3.3 — the weakest of the series. Label drift was the
 * symptom of evaluating outside the declared perimeter, not mere untidiness.
 *
 * The YAML is read with a narrow regex rather than js-yaml so this script stays
 * dependency-free like its siblings and runs in a bare worktree.
 *
 * This script NEVER writes. `--suggest` only prints what a migration would do.
 *
 * Run: node check-archetypes.mjs            (JSON to stdout)
 *      node check-archetypes.mjs --summary  (human-readable table)
 *      node check-archetypes.mjs --suggest  (proposed mapping, writes nothing)
 *      node check-archetypes.mjs --strict   (exit 1 on any non-canonical label)
 *      node check-archetypes.mjs --self-test
 *      node check-archetypes.mjs --help
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { hasFlag, validateFlags } from './lib/cli-flags.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const KNOWN_FLAGS = ['--summary', '--suggest', '--strict', '--self-test', '--help', '-h'];

const USAGE = [
  'Usage:',
  '  node check-archetypes.mjs             # JSON report to stdout',
  '  node check-archetypes.mjs --summary   # human-readable table',
  '  node check-archetypes.mjs --suggest   # proposed canonical mapping (writes nothing)',
  '  node check-archetypes.mjs --strict    # exit 1 on any non-canonical label',
  '  node check-archetypes.mjs --self-test',
  '  node check-archetypes.mjs --help',
  '',
  'The canonical vocabulary is read from config/profile.yml -> target_roles.archetypes[].name.',
  'This script never writes: it reports, and --suggest only prints what a migration would do.',
].join('\n');

// --- pure logic --------------------------------------------------------------

const ARCHETYPE_NAME_RE = /^\s*-\s+name:\s*"([^"]+)"/;
const ARCHETYPE_FIT_RE = /^\s*fit:\s*"([^"]+)"/;
const ARCHETYPE_LINE_RE = /^archetype:\s*(.+)$/m;

/**
 * Canonical archetypes from config/profile.yml, in declaration order.
 * Read with a narrow regex rather than js-yaml to stay dependency-free: the
 * block is a fixed shape the profile template ships, not arbitrary YAML.
 */
export function parseCanonicalArchetypes(yamlText) {
  const lines = String(yamlText ?? '').split(/\r?\n/);
  const out = [];
  let baseIndent = null;
  for (const line of lines) {
    if (baseIndent === null) {
      const header = line.match(/^(\s*)archetypes:\s*$/);
      if (header) baseIndent = header[1].length;
      continue;
    }
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    const name = line.match(ARCHETYPE_NAME_RE);
    if (name) { out.push({ name: name[1], fit: null }); continue; }
    const fit = line.match(ARCHETYPE_FIT_RE);
    if (fit && out.length) out[out.length - 1].fit = fit[1];
  }
  return out;
}

/**
 * Significant tokens of a canonical name, parenthetical qualifiers dropped.
 * "Quantitative Developer (pricing, backtesting)" -> ["quantitative","developer"],
 * so a report saying merely "Quantitative Developer" still resolves to it.
 */
export function coreTokens(name) {
  return String(name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function labelTokens(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Relate a report's free-text archetype label to the declared vocabulary.
 * A canonical name matches when every one of its core tokens appears as a whole
 * token of the label — never as a substring, and separators are irrelevant, so
 * "Applied ML / AI Engineer" survives being a name that contains a slash.
 */
export function resolveLabel(label, canonicalNames) {
  const raw = String(label ?? '').trim();
  const lt = labelTokens(raw);
  const matches = canonicalNames.filter((name) => {
    const ct = coreTokens(name);
    return ct.length > 0 && ct.every((t) => lt.includes(t));
  });
  if (!matches.length) return { label: raw, status: 'unmapped', matches: [] };
  const verbatim = canonicalNames.filter((name) => raw === name || raw.includes('"' + name + '"'));
  const status = verbatim.length > 0 && verbatim.length === matches.length ? 'canonical' : 'mappable';
  return { label: raw, status, matches };
}

/** The Machine Summary's archetype value, surrounding quotes stripped. */
export function extractArchetypeLine(markdown) {
  const m = String(markdown ?? '').match(ARCHETYPE_LINE_RE);
  if (!m) return null;
  return m[1].trim().replace(/^"(.*)"$/, '$1');
}

/** Every report's label, resolved against the declared vocabulary. */
export function auditReports(root = CAREER_OPS) {
  const profilePath = join(root, 'config', 'profile.yml');
  if (!existsSync(profilePath)) throw new Error('config/profile.yml introuvable');
  const canonical = parseCanonicalArchetypes(readFileSync(profilePath, 'utf8'));
  if (!canonical.length) throw new Error('aucun archetype declare dans config/profile.yml');
  const names = canonical.map((a) => a.name);

  const reportsDir = join(root, 'reports');
  const reports = existsSync(reportsDir)
    ? readdirSync(reportsDir).filter((f) => f.endsWith('.md')).sort()
    : [];

  const entries = [];
  for (const file of reports) {
    const label = extractArchetypeLine(readFileSync(join(reportsDir, file), 'utf8'));
    if (label === null) { entries.push({ report: file, label: null, status: 'missing', matches: [] }); continue; }
    entries.push({ report: file, ...resolveLabel(label, names) });
  }

  const tally = { canonical: 0, mappable: 0, unmapped: 0, missing: 0 };
  for (const e of entries) tally[e.status]++;
  return { canonical, entries, tally };
}

// --- self-test ---------------------------------------------------------------

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: err.message }); }
};
const eq = (a, b, label) => { if (a !== b) throw new Error(label + ': attendu ' + b + ', obtenu ' + a); };
const eqArr = (a, b, label) => eq(JSON.stringify(a), JSON.stringify(b), label);

const CANON = [
  'Quantitative Researcher (Crypto/DeFi & TradFi)',
  'Quantitative Developer (pricing, backtesting)',
  'Applied ML / AI Engineer',
  'AI Platform / MLOps Engineer',
  'Risk / Financial Engineer',
];

function selfTest() {
  check('parseCanonicalArchetypes lit la liste et les fits', () => {
    const yaml = [
      'target_roles:',
      '  archetypes:',
      '    - name: "Quantitative Researcher (Crypto/DeFi & TradFi)"',
      '      level: "Junior"',
      '      fit: "primary"',
      '    - name: "Risk / Financial Engineer"',
      '      fit: "adjacent"',
      'language:',
    ].join('\n');
    const list = parseCanonicalArchetypes(yaml);
    eq(list.length, 2, 'nombre');
    eq(list[0].name, 'Quantitative Researcher (Crypto/DeFi & TradFi)', 'nom');
    eq(list[0].fit, 'primary', 'fit');
    eq(list[1].fit, 'adjacent', 'fit 2');
  });

  check('coreTokens retire le qualificatif entre parentheses', () =>
    eqArr(coreTokens('Quantitative Developer (pricing, backtesting)'), ['quantitative', 'developer'], 'core'));
  check('coreTokens conserve un nom sans parentheses', () =>
    eqArr(coreTokens('Applied ML / AI Engineer'), ['applied', 'ml', 'ai', 'engineer'], 'core'));

  check('resolveLabel reconnait un nom canonique verbatim', () => {
    const r = resolveLabel('Quantitative Researcher (Crypto/DeFi & TradFi)', CANON);
    eq(r.status, 'canonical', 'statut');
    eqArr(r.matches, ['Quantitative Researcher (Crypto/DeFi & TradFi)'], 'match');
  });
  check('resolveLabel mappe un libelle abrege', () => {
    const r = resolveLabel('Quantitative Developer', CANON);
    eq(r.status, 'mappable', 'statut');
    eqArr(r.matches, ['Quantitative Developer (pricing, backtesting)'], 'match');
  });
  check('resolveLabel rend les deux archetypes d un hybride', () => {
    const r = resolveLabel('Risk / Financial Engineer x Quantitative Developer', CANON);
    eq(r.status, 'mappable', 'statut');
    eq(r.matches.length, 2, 'deux archetypes');
  });
  check('resolveLabel signale un poste hors ciblage', () => {
    const r = resolveLabel('Quantitative Trader (graduate)', CANON);
    eq(r.status, 'unmapped', 'statut');
    eq(r.matches.length, 0, 'aucun match');
  });
  check('resolveLabel ne confond pas Applied ML avec Applied ML / AI Engineer', () =>
    eq(resolveLabel('Quantitative Researcher (Trading) / Applied ML', CANON).matches.length, 1, 'un seul'));
  check('resolveLabel accepte une liste YAML', () => {
    const r = resolveLabel('["Risk / Financial Engineer", "Quantitative Developer"]', CANON);
    eq(r.matches.length, 2, 'deux archetypes');
  });
  check('resolveLabel tolere un separateur en tiret', () =>
    eq(resolveLabel('Quantitative Developer / Risk-Financial Engineer', CANON).matches.length, 2, 'deux'));
  check('resolveLabel rend unmapped sur une chaine vide', () =>
    eq(resolveLabel('', CANON).status, 'unmapped', 'statut'));

  check('extractArchetypeLine lit le champ du Machine Summary', () => {
    const md = ['# Rapport', 'score: 4.2', 'archetype: "Quantitative Developer"', 'risk_level: "Low"'].join('\n');
    eq(extractArchetypeLine(md), 'Quantitative Developer', 'libelle');
  });
  check('extractArchetypeLine rend null quand le champ manque', () =>
    eq(extractArchetypeLine('# Rapport sans machine summary'), null, 'null'));

  for (const r of results) console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : ' — ' + r.error));
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passés');
  return failed === 0 ? 0 : 1;
}

function main(argv) {
  const args = argv.slice(2);
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) { console.log(USAGE); return 0; }
  validateFlags(args, KNOWN_FLAGS, USAGE);
  if (hasFlag(args, '--self-test')) return selfTest();

  let audit;
  try {
    audit = auditReports();
  } catch (err) {
    console.error('check-archetypes: ' + err.message);
    return 1;
  }

  const { canonical, entries, tally } = audit;
  const nonCanonical = entries.filter((e) => e.status !== 'canonical');

  if (hasFlag(args, '--suggest')) {
    console.log('Correspondance proposée — rien n\'est écrit.\n');
    for (const e of nonCanonical) {
      const num = e.report.slice(0, 3);
      if (e.status === 'unmapped') {
        console.log('  #' + num + '  HORS CIBLAGE  "' + e.label + '"');
        console.log('        → archetype: ["unmapped"]  (aucun archétype déclaré ne correspond)');
      } else if (e.status === 'missing') {
        console.log('  #' + num + '  champ archetype absent du Machine Summary');
      } else {
        console.log('  #' + num + '  "' + e.label + '"');
        console.log('        → archetype: ' + JSON.stringify(e.matches));
      }
    }
    console.log('\n' + nonCanonical.length + ' rapport(s) à migrer sur ' + entries.length + '.');
    return 0;
  }

  if (hasFlag(args, '--summary')) {
    console.log('Vocabulaire déclaré (config/profile.yml) :');
    for (const a of canonical) console.log('  - ' + a.name + (a.fit ? '  [' + a.fit + ']' : ''));
    console.log('\nRapports : ' + entries.length + ' | canonical ' + tally.canonical
      + ' · mappable ' + tally.mappable + ' · unmapped ' + tally.unmapped + ' · missing ' + tally.missing);
    if (tally.unmapped) {
      console.log('\nHors ciblage déclaré — aucun archétype ne correspond :');
      for (const e of entries.filter((x) => x.status === 'unmapped')) {
        console.log('  #' + e.report.slice(0, 3) + '  "' + e.label + '"');
      }
    }
    if (tally.mappable) console.log('\n' + tally.mappable + ' libellé(s) résolvable(s) mais non verbatim — voir --suggest.');
    return hasFlag(args, '--strict') && nonCanonical.length ? 1 : 0;
  }

  console.log(JSON.stringify({ canonical, tally, entries }, null, 2));
  return hasFlag(args, '--strict') && nonCanonical.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
