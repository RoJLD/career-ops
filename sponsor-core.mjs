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
