/**
 * report-identity.mjs — resolve {company, role} for a report number.
 *
 * The per-offer bundle layout groups deliverables by company
 * (`output/{company}/{NNN}-{role}/vNNN/`), so it needs two facts the report
 * FILENAME cannot supply. `reports/021-algoquant-2026-09-07.md` and
 * `reports/022-algoquant-2026-09-10.md` reduce to the same slug, which is the
 * bug this module exists to remove: two ALGOQUANT bundles that only an
 * archaeologist could tell apart.
 *
 * WHY THE MACHINE SUMMARY AND NOT THE H1
 *
 * Every report carries a `## Machine Summary` YAML fence with `company:` and
 * `role:` scalars. Measured across the 23 reports in this repo:
 *
 *   - 23/23 carry both keys.
 *   - `company:` matches the tracker's Company column 23/23.
 *   - It is already free of the parentheticals prose carries: the H1 says
 *     `Santander (SCIB)`, the fence says `Santander`. Reports 017 and 018 put
 *     that same `(SCIB)` in the ROLE half, so a strip rule has to run on both
 *     fields no matter which source wins.
 *   - The filename slug disagrees with it for 9 of 23 (qube, chicago-trading,
 *     jane-street-qr/qt, imc-trader, acadian, santander-market-risk,
 *     santander-inflation-quant, shell-gas-quant) — because that slug is
 *     ALREADY a hand-made company+role disambiguator. It cannot serve as the
 *     company segment of a layout that groups by company.
 *
 * The H1 (`# Evaluation: {Company} — {Role}`) is the fallback, not the source.
 * It parses cleanly today, but it depends on an em dash surviving in prose:
 * the day someone types a hyphen, a filename-derived pipeline would stop. A
 * structured field has no such failure mode.
 *
 * NOTHING HERE THROWS ON A PARSE FAILURE.
 *
 * `bundle.mjs next` is called mid-application, after a CV has been built. A
 * throw there strands a deliverable in a temp path. So parsing degrades:
 * fence -> H1 -> filename slug with a null role. Only a genuinely missing
 * report file throws, which is the same contract resolveSlug() always had.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

import { asciiFold } from './ascii-fold.mjs';

/** Zero-pad a report number to the canonical 3 digits. */
export function padReport(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`report must be a number, got "${value}"`);
  return raw.padStart(3, '0');
}

/**
 * Legal-form tokens dropped from a company slug.
 *
 * Deliberately narrow. It holds incorporation forms only — never business
 * descriptors, because those distinguish real companies: Citadel and Citadel
 * Securities are different employers, and "Qube Research & Technologies" keeps
 * both descriptors. The one judgement call is `company`, which earns its place
 * by turning "Chicago Trading Company" into `chicago-trading`, matching the
 * folder that already exists on disk.
 */
const LEGAL_FORM_TOKENS = new Set([
  'company', 'corporation', 'corp', 'inc', 'incorporated',
  'ltd', 'limited', 'llc', 'llp', 'plc',
  'gmbh', 'ag', 'sa', 'sas', 'sarl', 'bv', 'nv', 'spa', 'pty', 'ab', 'oy', 'as',
]);

/** Dropped from a role slug. Seniority words are NOT here, and must never be. */
const ROLE_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'to', 'with', 'in', 'at']);

const COMPANY_BUDGET = 32;
const ROLE_BUDGET = 48;
const ROLE_MIN_TOKENS = 3;

/**
 * Shared normalisation: strip parentheticals, resolve ampersands, ASCII-fold.
 *
 * The ampersand rule runs BEFORE asciiFold because the two disagree on intent.
 * asciiFold's `punctuation: 'space'` turns "R&D" into two words; that is right
 * for " & " between names ("Qube Research & Technologies") and wrong glued
 * ("S&P" should not become "s p"). Handling it here keeps asciiFold's own
 * contract untouched — it is a system-layer file (update-system.mjs:231) and
 * vendoring a private copy would fork a shared normaliser for one caller.
 */
function normalizeBase(value, { stripParens = true } = {}) {
  let out = String(value ?? '').trim();
  if (stripParens) {
    const stripped = out.replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
    // A name that is ONLY a parenthetical keeps its contents rather than
    // becoming empty — "(Confidential)" is still more use than a hash.
    out = stripped || out.replace(/[()[\]]/g, '').trim();
  }
  out = out.replace(/(\S)&(\S)/g, '$1$2').replace(/\s*&\s*/g, ' ');
  return asciiFold(out, { punctuation: 'space' }).split(/\s+/).filter(Boolean);
}

/** Drop whole trailing tokens until the joined slug fits the budget. */
function fitBudget(tokens, budget, minTokens = 1) {
  const out = [...tokens];
  while (out.length > minTokens && out.join('-').length > budget) out.pop();
  return out;
}

/**
 * Company folder name. Groups every offer from one employer.
 *
 * Stability matters more than beauty here: if this returns a different string
 * for the same employer on two different reports, the layout silently creates
 * a second folder and un-groups the very thing it exists to group. That is why
 * the input is the structured `company:` field and the rules are subtractive.
 */
export function companySlug(company) {
  const tokens = normalizeBase(company);
  const kept = tokens.filter((t) => !LEGAL_FORM_TOKENS.has(t));
  // Never let the legal-form filter empty the name: "SA" alone is a company.
  const base = kept.length ? kept : tokens;
  const slug = fitBudget(base, COMPANY_BUDGET).join('-');
  if (slug) return slug;
  return `company-${createHash('sha1').update(String(company ?? '')).digest('hex').slice(0, 8)}`;
}

/**
 * Role folder name, WITHOUT the report-number prefix.
 *
 * Uniqueness inside a company folder is guaranteed by that prefix, not by this
 * string, so it is free to be short and readable. Seniority words survive on
 * purpose — "Associate" vs "Vice President" is the difference between reports
 * 017 and 018.
 */
export function roleSlug(role) {
  const tokens = normalizeBase(role);
  const kept = tokens.filter((t) => !ROLE_STOPWORDS.has(t));
  const base = kept.length ? kept : tokens;
  const slug = fitBudget(base, ROLE_BUDGET, ROLE_MIN_TOKENS).join('-');
  return slug || 'role';
}

/** The report file for a number, or null. */
export function findReportFile(report, root) {
  const num = padReport(report);
  const reportsDir = join(root, 'reports');
  if (!existsSync(reportsDir)) return null;
  const match = readdirSync(reportsDir).find((f) => f.startsWith(`${num}-`) && f.endsWith('.md'));
  return match ? join(reportsDir, match) : null;
}

/** The legacy filename slug: everything between `{NNN}-` and the trailing date. */
export function filenameSlug(filename, num) {
  return filename
    .slice(num.length + 1)
    .replace(/-\d{4}-\d{2}-\d{2}\.md$/, '')
    .replace(/\.md$/, '');
}

/**
 * Pull a top-level scalar out of the Machine Summary fence.
 *
 * Anchored to column 0 so it cannot match a nested list item — `soft_gaps`
 * entries are indented, top-level keys never are. Quotes are optional because
 * both spellings appear across the corpus.
 */
function fenceScalar(fence, key) {
  const m = fence.match(new RegExp(String.raw`^${key}:[ \t]*(.+)$`, 'm'));
  if (!m) return null;
  const raw = m[1].trim().replace(/\s+#.*$/, '').trim();
  const unquoted = raw.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  return unquoted || null;
}

const FENCE_RE = /##\s*Machine Summary\s*\n+```(?:yaml|yml|json)?\s*\n([\s\S]*?)\n```/i;
const H1_RE = /^#\s*Evaluation:\s*(.+)$/m;

/**
 * Resolve a report to {num, company, role, companySlug, roleSlug, source}.
 *
 * `source` records WHICH reading won, so callers can report a degraded parse
 * instead of silently shipping a worse folder name.
 *
 * @throws when no report file exists for the number — the one unrecoverable case.
 */
export function reportIdentity(report, root) {
  const num = padReport(report);
  const file = findReportFile(num, root);
  if (!file) throw new Error(`no report file found for ${num} in reports/`);

  const filename = file.split(/[\\/]/).pop();
  const fallbackCompany = filenameSlug(filename, num);
  const content = readFileSync(file, 'utf8');

  const fence = content.match(FENCE_RE);
  if (fence) {
    const company = fenceScalar(fence[1], 'company');
    const role = fenceScalar(fence[1], 'role');
    if (company && role) {
      return {
        num, company, role, source: 'machine-summary',
        companySlug: companySlug(company), roleSlug: roleSlug(role),
      };
    }
  }

  // The H1 splits on an em/en dash. `split` then `shift`/`join` rather than a
  // capture pair, so a role that itself contains a dash keeps it.
  const h1 = content.match(H1_RE);
  if (h1) {
    const parts = h1[1].split(/\s+[—–]\s+/);
    if (parts.length >= 2) {
      const company = parts.shift().trim();
      const role = parts.join(' - ').trim();
      if (company && role) {
        return {
          num, company, role, source: 'h1',
          companySlug: companySlug(company), roleSlug: roleSlug(role),
        };
      }
    }
  }

  return {
    num, company: fallbackCompany, role: null, source: 'filename',
    companySlug: companySlug(fallbackCompany.replace(/-/g, ' ')), roleSlug: 'unknown-role',
  };
}
