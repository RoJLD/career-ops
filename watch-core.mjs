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

const SCORE_RE = /^(\d+(?:\.\d+)?)\/5$/;

/** Score numérique d'une cellule, ou null pour une sentinelle (N/A, —, -). */
export function parseScoreCell(cell) {
  const m = String(cell ?? '').trim().match(SCORE_RE);
  return m ? Number(m[1]) : null;
}

/** Numéro de rapport zéro-padé extrait d'une cellule Report, ou null. */
export function reportNumberFromCell(cell) {
  const m = String(cell ?? '').match(/\[(\d+)\]/);
  return m ? m[1].padStart(3, '0') : null;
}

/** Jours entiers entre deux dates ISO (YYYY-MM-DD). */
export function daysBetweenIso(fromIso, toIso) {
  const ms = Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`);
  return Math.floor(ms / 86400000);
}

/** Évaluations non candidatées, anciennes et au-dessus du seuil de score. */
export function detectStaleEvaluations(rows, { today, staleDays = 7, minScore = 4.0 }) {
  const findings = [];
  for (const r of rows) {
    if (r.status !== 'Evaluated') continue;
    const score = parseScoreCell(r.score);
    if (score === null || score < minScore) continue;
    const report = reportNumberFromCell(r.report);
    if (!report) continue;
    const age = daysBetweenIso(r.date, today);
    if (age <= staleDays) continue;
    findings.push({
      type: 'stale', report, company: r.company,
      detail: `${r.company} ${score}/5, évaluée il y a ${age} j, jamais candidatée`,
    });
  }
  return findings;
}

const LIVENESS_LINE_RE = /^\S+\s+(active|expired|uncertain)\s+(?:\(api\)\s+)?(\S+)$/;

/** Statuts par URL, lus depuis la sortie texte de check-liveness.mjs. */
export function parseLivenessOutput(stdout) {
  const map = new Map();
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = line.trim().match(LIVENESS_LINE_RE);
    if (m && m[2].startsWith('http')) map.set(m[2], m[1]);
  }
  return map;
}

/** Offres non candidatées dont l'annonce est explicitement expirée. */
export function detectDeadPostings(rows, livenessByUrl, urlByReport) {
  const findings = [];
  for (const r of rows) {
    if (r.status !== 'Evaluated') continue;
    const report = reportNumberFromCell(r.report);
    if (!report) continue;
    const url = urlByReport.get(report);
    if (!url) continue;
    if (livenessByUrl.get(url) !== 'expired') continue;
    findings.push({
      type: 'dead', report, company: r.company,
      detail: `${r.company} — l'annonce n'est plus en ligne`,
    });
  }
  return findings;
}

/** Un constat `dead` rend le `stale` du même rapport sans objet. */
export function suppressRedundant(findings) {
  const dead = new Set(findings.filter(f => f.type === 'dead').map(f => f.report));
  return findings.filter(f => !(f.type === 'stale' && dead.has(f.report)));
}

const ACTIONABLE_URGENCY = new Set(['overdue', 'urgent']);

/** Numéro de rapport zéro-padé depuis un chemin `reports/NNN-slug-date.md`. */
export function reportNumberFromPath(path) {
  const m = String(path ?? '').match(/(?:^|[/\\])(\d+)-/);
  return m ? m[1].padStart(3, '0') : null;
}

/** Relances dues, d'après la sortie de followup-cadence.mjs. */
export function detectFollowupsDue(cadenceEntries) {
  const findings = [];
  for (const e of cadenceEntries ?? []) {
    if (!ACTIONABLE_URGENCY.has(e.urgency)) continue;
    const report = reportNumberFromPath(e.reportPath);
    if (!report) continue;
    const late = typeof e.daysUntilNext === 'number' && e.daysUntilNext < 0
      ? ` depuis ${Math.abs(e.daysUntilNext)} j` : '';
    findings.push({
      type: 'followup', report, company: e.company,
      detail: `${e.company} (${e.status}) — relance due${late}`,
    });
  }
  return findings;
}

/** Assemble les trois détecteurs, supprime la redondance, puis déduplique. */
export function collectFindings({ rows, livenessByUrl, urlByReport, cadenceEntries, pendingTexts, opts }) {
  const all = [
    ...detectDeadPostings(rows, livenessByUrl, urlByReport),
    ...detectFollowupsDue(cadenceEntries),
    ...detectStaleEvaluations(rows, opts),
  ];
  return filterAlreadyQueued(suppressRedundant(all), pendingTexts);
}
