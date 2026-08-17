#!/usr/bin/env node
/**
 * watch-core.mjs — logique pure du veilleur de pipeline.
 * Aucun I/O : pas de fs, pas de réseau, pas d'horloge. `today` est injecté.
 * Voir .planning/watch-design.md
 */

/** Clé stable d'un constat. Contrat inter-runs : la changer réinitialise la dédup. */
export function findingKey(finding) {
  return `watch:${finding.type}:${finding.report}`;
}

/** Textes des items NON cochés de data/agent-inbox.md. */
export function parseInboxPending(markdown) {
  return String(markdown ?? '')
    .split(/\r?\n/)
    .filter(line => line.trimStart().startsWith('- [ ]'))
    .map(line => line.trim());
}

/** Constats dont la clé n'est pas déjà pendante. */
export function filterAlreadyQueued(findings, pendingTexts) {
  const queued = new Set();
  for (const text of pendingTexts) {
    const m = text.match(/\[(watch:[a-z]+:\d{3})\]/);
    if (m) queued.add(m[1]);
  }
  return findings.filter(f => !queued.has(findingKey(f)));
}
