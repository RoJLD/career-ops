#!/usr/bin/env node
/**
 * sponsor-core.mjs — logique pure de résolution du sponsoring UK.
 * Aucun I/O : pas de fs, pas de réseau, pas d'horloge.
 * Voir .planning/sponsor-check-design.md
 */

/**
 * Suffixes d'entité légale retirés avant appariement. Le tracker porte des
 * marques ("DRW"), le registre des personnes morales ("DRW Investments (UK) Ltd").
 */
export const LEGAL_SUFFIXES = new Set([
  'ltd', 'limited', 'llp', 'plc', 'uk', 'europe', 'group', 'holdings',
  'services', 'investments', 'international', 'company', 'co', 'inc', 'llc',
]);

/** Minuscules, & -> and, ponctuation en espaces, espaces collapsés. */
export function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Tokens significatifs d'un nom. Si le retrait des suffixes vide la liste
 * (« Services Limited »), on retombe sur les tokens bruts : un appariement
 * trop strict vaut mieux qu'un appariement universel ou impossible.
 */
export function tokenize(value) {
  const all = normalizeName(value).split(' ').filter(Boolean);
  const kept = all.filter((t) => !LEGAL_SUFFIXES.has(t));
  return kept.length ? kept : all;
}

/**
 * Découpe une ligne CSV en respectant les guillemets. Le registre en contient
 * (~2900 lignes sur 142 780) : un split(',') naïf y décale toutes les colonnes.
 */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else { cur += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur.trim()); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** Lignes structurées du registre. L'en-tête est sauté, les vides ignorées. */
export function parseRegisterCsv(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = parseCsvLine(lines[i]);
    if (!c[0]) continue;
    rows.push({ name: c[0], city: c[1] || '', county: c[2] || '', rating: c[3] || '', route: c[4] || '' });
  }
  return rows;
}
