/**
 * kpi-core.mjs — stage-gated KPI computation (pure).
 *
 * No I/O, no clock, no process access: every input is injected. The shell
 * (kpi.mjs) reads files and prints; everything decidable lives here so it can
 * be tested without a filesystem.
 *
 * ── The one rule ────────────────────────────────────────────────────────
 * A KPI is LOCKED when its denominator is 0 — never because a stage was
 * declared "not reached yet".
 *
 * This distinction is the whole point of the module. Two numbers that both
 * render as "0%" mean opposite things:
 *
 *   0 applications out of 20 evaluated  → 0%, and it is the single most
 *                                         informative number on the board
 *   0 responses out of 0 applications   → not a rate at all; printing "0%"
 *                                         invents a failure that never had a
 *                                         chance to occur
 *
 * A dashboard that shows twelve metrics of which ten are structurally 0%
 * teaches its reader to stop reading it — followup-cadence.mjs documents the
 * same trap in its own header. So a KPI with an empty denominator is not
 * displayed as a value: it is displayed as locked, together with the exact
 * condition that unlocks it.
 *
 * ── Definitions are borrowed, never restated ────────────────────────────
 * The funnel counts (everApplied / everResponded / everInterview / everOffer)
 * are computed by stats.mjs's exported computeFunnel() and injected here. A
 * second definition of "applied" living in this file would drift from the one
 * stats.mjs prints, and the two dashboards would disagree about the same
 * search — the same failure the free-text archetype field produced before it
 * was given a controlled vocabulary.
 */

/** Score at or above which a role is considered worth applying to. */
export const DEFAULT_THRESHOLD = 4.0;

/** Denominators below this are reported as statistically thin, not hidden. */
export const SMALL_SAMPLE = 10;

/** Ordered stages. Index is meaningful: a later stage implies the earlier ones. */
export const STAGES = ['entry', 'conversion', 'process'];

export const STAGE_LABELS = {
  entry: 'Entrée',
  conversion: 'Conversion',
  process: 'Processus',
};

/**
 * Pull the fields we need out of one report's `## Machine Summary` block.
 *
 * Deliberately narrow: a YAML parser would accept the whole document and drag
 * in a dependency for two scalars. Both fields are matched only inside the
 * Machine Summary section, so a `score:` mentioned in prose above it cannot be
 * picked up by accident.
 *
 * @param {string} text - Raw report markdown.
 * @returns {{score: number|null, workAuth: string|null}}
 */
export function parseReportSummary(text) {
  const src = String(text ?? '').replace(/\r/g, '');
  const start = src.indexOf('## Machine Summary');
  const body = start === -1 ? '' : src.slice(start);
  if (!body) return { score: null, workAuth: null };

  const scoreMatch = body.match(/^\s*score:\s*"?([0-9]+(?:\.[0-9]+)?)"?/m);
  const authMatch = body.match(/^\s*work_auth:\s*"?([A-Za-z_-]+)"?/m);

  const score = scoreMatch ? Number(scoreMatch[1]) : null;
  return {
    score: Number.isFinite(score) ? score : null,
    workAuth: authMatch ? authMatch[1].toLowerCase() : null,
  };
}

/** Percentage with one decimal; null when the denominator is empty. */
export function rate(numerator, denominator) {
  if (!denominator || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Every KPI this board knows how to compute.
 *
 * `denominator` returning 0 is what locks a row — no stage is hardcoded as
 * unreachable. `stage` is presentation only: it groups rows and names what a
 * given phase of a search is supposed to be watching.
 */
export const KPI_DEFS = [
  {
    key: 'scan_yield',
    stage: 'entry',
    label: 'Rendement de scan',
    help: 'part des annonces scannées qui ont mérité une évaluation',
    unlock: 'au moins une annonce enregistrée dans data/scan-history.tsv',
    numerator: (d) => d.reports.length,
    denominator: (d) => d.scanned,
  },
  {
    key: 'evaluation_yield',
    stage: 'entry',
    label: 'Rendement d\'évaluation',
    help: 'part des rapports au-dessus du seuil de candidature',
    unlock: 'au moins un rapport dans reports/',
    numerator: (d) => d.reports.filter((r) => r.score != null && r.score >= d.threshold).length,
    denominator: (d) => d.reports.length,
  },
  {
    key: 'workauth_resolved',
    stage: 'entry',
    label: 'Autorisation de travail résolue',
    help: 'part des rapports où le sponsoring n\'est plus « unstated »',
    unlock: 'au moins un rapport dans reports/',
    numerator: (d) => d.reports.filter((r) => r.workAuth && r.workAuth !== 'unstated').length,
    denominator: (d) => d.reports.length,
  },
  {
    key: 'application_rate',
    stage: 'entry',
    label: 'Passage à la candidature',
    help: 'part des rapports qui ont donné lieu à un envoi — le critère de sortie de l\'étape',
    unlock: 'au moins un rapport dans reports/',
    numerator: (d) => d.funnel.everApplied,
    denominator: (d) => d.reports.length,
  },
  {
    key: 'response_rate',
    stage: 'conversion',
    label: 'Taux de réponse',
    help: 'part des candidatures ayant reçu une réponse',
    unlock: 'au moins une candidature envoyée (statut Applied dans data/applications.md)',
    owner: 'node funnel-velocity.mjs --summary',
    numerator: (d) => d.funnel.everResponded,
    denominator: (d) => d.funnel.everApplied,
  },
  {
    key: 'interview_rate',
    stage: 'conversion',
    label: 'Taux d\'entretien',
    help: 'part des candidatures ayant mené à un entretien',
    unlock: 'au moins une candidature envoyée (statut Applied dans data/applications.md)',
    owner: 'node funnel-velocity.mjs --summary',
    numerator: (d) => d.funnel.everInterview,
    denominator: (d) => d.funnel.everApplied,
  },
  {
    key: 'offer_rate',
    stage: 'process',
    label: 'Taux d\'offre',
    help: 'part des processus d\'entretien ayant abouti à une offre',
    unlock: 'au moins un entretien atteint (statut Interview dans data/applications.md)',
    owner: 'node funnel-velocity.mjs --summary',
    numerator: (d) => d.funnel.everOffer,
    denominator: (d) => d.funnel.everInterview,
  },
];

/**
 * Furthest stage whose entry condition is actually met by the data.
 *
 * Derived from the same funnel counts the KPIs use, so the headline stage can
 * never contradict the rows beneath it.
 */
export function currentStage(data) {
  if (data.funnel.everInterview > 0) return 'process';
  if (data.funnel.everApplied > 0) return 'conversion';
  return 'entry';
}

/**
 * Compute every KPI against one dataset.
 *
 * @param {object} input
 * @param {Array<{score: number|null, workAuth: string|null}>} input.reports
 * @param {{everApplied: number, everResponded: number, everInterview: number, everOffer: number}} input.funnel
 * @param {number} input.scanned - Jobs recorded in scan history.
 * @param {number} [input.threshold] - Apply-worthy score floor.
 * @returns {{stage: string, threshold: number, kpis: Array<object>, nextUnlock: object|null}}
 */
export function computeKpis({ reports = [], funnel = {}, scanned = 0, threshold = DEFAULT_THRESHOLD } = {}) {
  const data = {
    reports,
    scanned,
    threshold,
    funnel: {
      everApplied: funnel.everApplied || 0,
      everResponded: funnel.everResponded || 0,
      everInterview: funnel.everInterview || 0,
      everOffer: funnel.everOffer || 0,
    },
  };

  const kpis = KPI_DEFS.map((def) => {
    const denominator = def.denominator(data);
    const numerator = def.numerator(data);
    const locked = !denominator || denominator <= 0;
    return {
      key: def.key,
      stage: def.stage,
      label: def.label,
      help: def.help,
      state: locked ? 'locked' : 'computable',
      // A locked KPI carries no value at all — not 0, not null-as-zero. Callers
      // that format `value` cannot accidentally render an empty denominator as
      // "0%", which is the failure this module exists to prevent.
      value: locked ? null : rate(numerator, denominator),
      numerator: locked ? null : numerator,
      denominator: locked ? null : denominator,
      smallSample: !locked && denominator < SMALL_SAMPLE,
      unlock: locked ? def.unlock : null,
      // Which tool owns the deep version of this metric. kpi.mjs is a board,
      // not a rival implementation: the downstream rates are also computed by
      // funnel-velocity.mjs, against market benchmarks and with a velocity
      // ledger. Both read the same imported computeFunnel(), so they cannot
      // disagree — this field routes the reader to the richer answer.
      owner: def.owner || null,
    };
  });

  const stage = currentStage(data);
  // The cheapest thing that would light up a currently dark row. Reported as
  // guidance, never acted on.
  const nextUnlock = kpis.find((k) => k.state === 'locked') || null;

  return { stage, threshold, kpis, nextUnlock };
}

/**
 * Render the board.
 *
 * Locked rows are printed, never hidden: the reader learns which metric does
 * not apply yet and why, which is information a silently shortened list
 * destroys.
 */
export function formatSummary(result, { today = '' } = {}) {
  const out = [];
  const bar = '━'.repeat(62);
  out.push('');
  out.push(bar);
  out.push(`KPI — étape : ${STAGE_LABELS[result.stage]}${today ? ` — ${today}` : ''}`);
  out.push(bar);

  for (const stage of STAGES) {
    const rows = result.kpis.filter((k) => k.stage === stage);
    if (rows.length === 0) continue;
    const marker = stage === result.stage ? '▶' : ' ';
    out.push('');
    out.push(`${marker} ${STAGE_LABELS[stage].toUpperCase()}`);
    for (const k of rows) {
      if (k.state === 'locked') {
        out.push(`    ·  ${k.label} — verrouillé`);
        out.push(`       débloqué par : ${k.unlock}`);
        if (k.owner) out.push(`       analyse détaillée : ${k.owner}`);
      } else {
        const thin = k.smallSample ? '  (échantillon faible)' : '';
        out.push(`    ●  ${k.label} : ${k.value}%  (${k.numerator}/${k.denominator})${thin}`);
        out.push(`       ${k.help}`);
        if (k.owner) out.push(`       analyse détaillée : ${k.owner}`);
      }
    }
  }

  if (result.nextUnlock) {
    out.push('');
    out.push(`Prochain déverrouillage : ${result.nextUnlock.label}`);
    out.push(`  ${result.nextUnlock.unlock}`);
  }
  out.push('');
  return out.join('\n');
}
