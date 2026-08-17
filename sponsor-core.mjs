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

/**
 * Entités dont TOUS les tokens de la requête sont des tokens entiers.
 * Les lignes d'une même entité sont fusionnées, leurs routes dédoublonnées.
 */
export function matchEntities(query, rows) {
  const qt = tokenize(query);
  if (!qt.length) return [];
  const byName = new Map();
  for (const row of rows) {
    const rt = tokenize(row.name);
    if (!qt.every((t) => rt.includes(t))) continue;
    const existing = byName.get(row.name);
    if (existing) {
      if (row.route && !existing.routes.includes(row.route)) existing.routes.push(row.route);
    } else {
      byName.set(row.name, {
        name: row.name, city: row.city, rating: row.rating,
        routes: row.route ? [row.route] : [],
      });
    }
  }
  return [...byName.values()];
}

/** Une requête d'un seul token court est fragile — le consommateur doit le savoir. */
function isShortQuery(query) {
  const t = tokenize(query);
  return t.length === 1 && t[0].length < 4;
}

/**
 * Statut de sponsoring. `not-listed` signifie « inconnu », JAMAIS « non-sponsor » :
 * l'entreprise peut recruter sans sponsoring ou être enregistrée sous un nom de groupe.
 */
export function classifySponsorship(query, rows) {
  const entities = matchEntities(query, rows);
  const status = entities.length === 0 ? 'not-listed' : entities.length === 1 ? 'sponsor' : 'ambiguous';
  return { status, query, shortQuery: isShortQuery(query), entities };
}
