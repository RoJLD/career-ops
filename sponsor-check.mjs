#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';
import { hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { normalizeName, tokenize, parseCsvLine, parseRegisterCsv, matchEntities, classifySponsorship, extractRegisterUrl, isStale } from './sponsor-core.mjs';

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: err.message }); }
};
const eq = (a, b, label) => { if (a !== b) throw new Error(`${label}: attendu ${b}, obtenu ${a}`); };
const eqArr = (a, b, label) => eq(JSON.stringify(a), JSON.stringify(b), label);

function selfTest() {
  check('normalizeName met en minuscules et retire la ponctuation', () =>
    eq(normalizeName('DRW Investments (UK) Ltd'), 'drw investments uk ltd', 'norm'));
  check('normalizeName traduit & en and', () =>
    eq(normalizeName('Qube Research & Technologies'), 'qube research and technologies', 'norm'));
  check('normalizeName absorbe les espaces parasites du registre', () =>
    eq(normalizeName('  Asian African Foods Ltd  '), 'asian african foods ltd', 'norm'));
  check('tokenize retire les suffixes legaux', () =>
    eqArr(tokenize('DRW Investments (UK) Ltd'), ['drw'], 'tokens'));
  check('tokenize conserve les tokens metier', () =>
    eqArr(tokenize('Jane Street Europe Limited'), ['jane', 'street'], 'tokens'));
  check('tokenize retombe sur les tokens bruts si tout est suffixe', () =>
    eqArr(tokenize('Services Limited'), ['services', 'limited'], 'fallback'));
  check('parseCsvLine gere un champ entre guillemets avec virgule', () =>
    eqArr(parseCsvLine('MARGARET ROAD STORES LTD,"HAMILTON, ",,Worker (A rating),Skilled Worker'),
      ['MARGARET ROAD STORES LTD', 'HAMILTON,', '', 'Worker (A rating)', 'Skilled Worker'], 'csv'));
  check('parseCsvLine gere une ligne sans guillemets', () =>
    eqArr(parseCsvLine('Optiver UK Limited,London,,Worker (A rating),Skilled Worker'),
      ['Optiver UK Limited', 'London', '', 'Worker (A rating)', 'Skilled Worker'], 'csv'));
  check('parseCsvLine gere un guillemet double echappe', () =>
    eqArr(parseCsvLine('A,"B ""quoted"" C",,D,E'), ['A', 'B "quoted" C', '', 'D', 'E'], 'csv'));
  check('parseRegisterCsv saute l en-tete et structure les lignes', () => {
    const rows = parseRegisterCsv([
      'Organisation Name,Town/City,County,Type & Rating,Route',
      ' DRW Investments (UK) Ltd,London,,Worker (A rating),Skilled Worker',
      ' PhysicsX Limited ,London,,Worker (A rating),Skilled Worker',
    ].join('\n'));
    eq(rows.length, 2, 'nombre');
    eq(rows[0].name, 'DRW Investments (UK) Ltd', 'nom trime');
    eq(rows[1].route, 'Skilled Worker', 'route');
  });
  check('parseRegisterCsv ignore les lignes vides', () =>
    eq(parseRegisterCsv('Organisation Name,Town/City,County,Type & Rating,Route\n\n\n').length, 0, 'vide'));

  const REG = parseRegisterCsv([
    'Organisation Name,Town/City,County,Type & Rating,Route',
    'DRW Investments (UK) Ltd,London,,Worker (A rating),Global Business Mobility: Senior or Specialist Worker',
    'DRW Investments (UK) Ltd,London,,Worker (A rating),Skilled Worker',
    'AshlotrimCare Ltd,Milton Keynes,Bedfordshire,Worker (A rating),Skilled Worker',
    'CIMC Universal Tank Technologies (UK) Ltd,Skelmersdale,Lancashire,Worker (A rating),Skilled Worker',
    'IMC London Limited,London,,Worker (A rating),Skilled Worker',
    'IMC (UK) Learning Limited,London,,Worker (B rating),Skilled Worker',
    'Qube Research & Technologies Limited,London,,Worker (A rating),Skilled Worker',
  ].join('\n'));

  check('matchEntities dedoublonne les routes d une meme entite', () => {
    const m = matchEntities('DRW', REG);
    eq(m.length, 1, 'une entite');
    eq(m[0].routes.length, 2, 'deux routes');
  });
  check('matchEntities n apparie jamais une sous-chaine', () => {
    const names = matchEntities('IMC', REG).map((e) => e.name);
    eq(names.includes('AshlotrimCare Ltd'), false, 'AshlotrimCare exclu');
    eq(names.includes('CIMC Universal Tank Technologies (UK) Ltd'), false, 'CIMC exclu');
  });
  check('matchEntities collecte tous les ratings distincts d une entite (finding 2)', () => {
    const rows = parseRegisterCsv([
      'Organisation Name,Town/City,County,Type & Rating,Route',
      'NETLIGHT CONSULTING LIMITED,London,,Worker (A rating),Skilled Worker',
      'NETLIGHT CONSULTING LIMITED,London,,Worker (B rating),Skilled Worker',
    ].join('\n'));
    const m = matchEntities('NETLIGHT CONSULTING', rows);
    eq(m.length, 1, 'une entite');
    eqArr(m[0].ratings, ['Worker (A rating)', 'Worker (B rating)'], 'les deux ratings remontent, pas seulement le premier');
  });
  check('matchEntities fusionne deux lignes ne differant que par la casse/espacement (finding 3)', () => {
    const rows = parseRegisterCsv([
      'Organisation Name,Town/City,County,Type & Rating,Route',
      '186 LONDON LIMITED,London,,Worker (A rating),Skilled Worker',
      '186 London Limited,London,,Worker (A rating),Skilled Worker',
    ].join('\n'));
    const m = matchEntities('186 London', rows);
    eq(m.length, 1, 'une seule entite malgre la casse differente, pas ambiguous a tort');
  });
  check('matchEntities collecte les villes distinctes plutot que d en perdre une (finding 3)', () => {
    const rows = parseRegisterCsv([
      'Organisation Name,Town/City,County,Type & Rating,Route',
      '1ST CHOICE CABS LTD,London,,Worker (A rating),Skilled Worker',
      '1st Choice Cabs Ltd,Ilford,,Worker (A rating),Skilled Worker',
    ].join('\n'));
    const m = matchEntities('1st Choice Cabs', rows);
    eq(m.length, 1, 'une entite');
    eqArr(m[0].cities, ['London', 'Ilford'], 'les deux villes sont conservees, aucune ecrasee silencieusement');
  });
  check('classifySponsorship rend sponsor sur une entite unique', () => {
    const r = classifySponsorship('Qube Research & Technologies', REG);
    eq(r.status, 'sponsor', 'statut');
    eq(r.entities[0].name, 'Qube Research & Technologies Limited', 'entite');
  });
  check('classifySponsorship rend ambiguous sur plusieurs entites', () =>
    eq(classifySponsorship('IMC', REG).status, 'ambiguous', 'statut'));
  check('classifySponsorship rend not-listed sans correspondance', () =>
    eq(classifySponsorship('Pigment', REG).status, 'not-listed', 'statut'));
  check('classifySponsorship marque les requetes courtes', () => {
    eq(classifySponsorship('DRW', REG).shortQuery, true, 'DRW court');
    eq(classifySponsorship('Qube Research & Technologies', REG).shortQuery, false, 'nom long');
  });

  check('extractRegisterUrl trouve le lien CSV dans le HTML brut', () => {
    const html = '<a class="govuk-link" href="https://assets.publishing.service.gov.uk/media/6a82c974/SP_-_Worker_and_Temporary_Worker_Web_Register_-_2026-08-17.csv">Download CSV</a>';
    eq(extractRegisterUrl(html),
       'https://assets.publishing.service.gov.uk/media/6a82c974/SP_-_Worker_and_Temporary_Worker_Web_Register_-_2026-08-17.csv', 'url');
  });
  check('extractRegisterUrl ignore un CSV sans rapport', () =>
    eq(extractRegisterUrl('<a href="https://assets.publishing.service.gov.uk/media/abc/Some_Other_File.csv">x</a>'), null, 'url'));
  check('extractRegisterUrl rend null sans lien', () =>
    eq(extractRegisterUrl('<html><body>rien</body></html>'), null, 'url'));
  check('isStale compare des dates injectees', () => {
    eq(isStale('2026-08-01T00:00:00Z', '2026-08-17T00:00:00Z', 7), true, 'perime');
    eq(isStale('2026-08-15T00:00:00Z', '2026-08-17T00:00:00Z', 7), false, 'frais');
  });

  // Finding 1 : un flag mal frappe (`-summary` pour `--summary`) ne doit
  // JAMAIS devenir la requete — ce serait fabriquer un faux not-listed.
  // Verifie via un vrai sous-processus CLI : validateFlags() appelle
  // process.exit() elle-meme, donc ce chemin ne peut pas etre teste en
  // appelant main() dans le processus du self-test. Aucun acces reseau :
  // le rejet du flag inconnu se produit avant tout chargement du registre.
  check('CLI rejette un flag inconnu au lieu de le prendre pour la requete (finding 1, #1633/#2743/#2744/#2775)', () => {
    const self = fileURLToPath(import.meta.url);
    const r = spawnSync(process.execPath, [self, '-summary', 'DRW'], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0) throw new Error(`code de sortie attendu != 0, obtenu 0 — stdout: ${r.stdout}`);
    if (/not-listed/.test(r.stdout)) {
      throw new Error(`le flag mal frappe a produit un verdict not-listed au lieu d etre rejete : ${r.stdout}`);
    }
    if (!/flag/i.test(r.stderr) && !/flag/i.test(r.stdout)) {
      throw new Error(`aucun message d erreur de flag inconnu trouve — stdout: ${r.stdout} stderr: ${r.stderr}`);
    }
  });

  // Finding 6 : ecriture atomique du cache (fichier temporaire + rename),
  // exercee ici sur un chemin scratch — jamais sur data/sponsor-register.csv.
  check('writeFileAtomic ecrit le contenu final sans laisser de fichier temporaire (finding 6)', () => {
    const scratch = join(tmpdir(), `sponsor-check-selftest-${process.pid}-${Date.now()}.csv`);
    try {
      writeFileAtomic(scratch, 'contenu de test');
      eq(readFileSync(scratch, 'utf8'), 'contenu de test', 'contenu final');
      const stray = readdirSync(dirname(scratch)).some((f) => f.startsWith(`${basename(scratch)}.tmp-`));
      eq(stray, false, 'aucun fichier .tmp- residuel');
    } finally {
      if (existsSync(scratch)) unlinkSync(scratch);
    }
  });

  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passés`);
  return failed === 0 ? 0 : 1;
}

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { tmpdir } from 'os';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Surchargeable par SPONSOR_PUBLICATION_URL — c'est ce qui rend le chemin
// d'echec testable a la main (Step 6b) sans couper le reseau de la machine.
const PUBLICATION_URL = process.env.SPONSOR_PUBLICATION_URL
  || 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers';
const CACHE_CSV = join(CAREER_OPS, 'data', 'sponsor-register.csv');
const CACHE_META = join(CAREER_OPS, 'data', 'sponsor-register.meta.json');
const MAX_AGE_DAYS = 7;

const USAGE = `Usage:
  node sponsor-check.mjs "<nom complet de l'entreprise>"   # statut JSON
  node sponsor-check.mjs "<nom>" --summary                 # lecture humaine
  node sponsor-check.mjs "<nom>" --refresh                 # force le rafraichissement
  node sponsor-check.mjs --self-test
  node sponsor-check.mjs --help

Interroger avec le nom COMPLET : "Qube" rend 8 entites, "Qube Research & Technologies" en rend 1.
Un statut not-listed signifie "inconnu", jamais "non-sponsor". Le script ne rejette aucune offre.`;

// Un flag mal frappe (`-summary`, `--summry`) ne doit JAMAIS tomber dans la
// requete : ce serait fabriquer un faux `not-listed` (finding 1, meme defaut
// que #1633/#2743/#2744/#2775). validateFlags() rejette tout token inconnu
// commencant par '-' avant qu'il ne soit pris pour un nom d'entreprise.
const KNOWN_FLAGS = ['--summary', '--refresh', '--self-test', '--help', '-h'];

/**
 * Ecriture atomique : fichier temporaire dans le meme repertoire, puis
 * renameSync par-dessus la cible. Sans cela, un lecteur concurrent du CSV de
 * 11 Mo peut lire un fichier tronque pendant l'ecriture (finding 6).
 */
function writeFileAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

/** Télécharge le registre courant et met à jour le cache. Renvoie le texte CSV. */
async function refreshRegister() {
  const page = await fetch(PUBLICATION_URL);
  if (!page.ok) throw new Error(`page de publication HTTP ${page.status}`);
  const url = extractRegisterUrl(await page.text());
  if (!url) throw new Error('lien CSV introuvable sur la page de publication');
  const csv = await fetch(url);
  if (!csv.ok) throw new Error(`CSV HTTP ${csv.status}`);
  const text = await csv.text();
  mkdirSync(dirname(CACHE_CSV), { recursive: true });
  writeFileAtomic(CACHE_CSV, text);
  writeFileAtomic(CACHE_META, JSON.stringify({
    fetchedAt: new Date().toISOString(), url, bytes: text.length,
  }, null, 2));
  return text;
}

/**
 * Texte du registre : cache s'il est frais, sinon rafraîchissement.
 * Un échec réseau AVEC cache retombe sur le cache et annonce son âge ;
 * sans cache, l'appelant rendra `unavailable` — jamais une supposition.
 */
async function loadRegister(force, nowIso) {
  let meta = null;
  if (existsSync(CACHE_META)) { try { meta = JSON.parse(readFileSync(CACHE_META, 'utf8')); } catch { meta = null; } }
  const cached = existsSync(CACHE_CSV);
  const stale = !meta || isStale(meta.fetchedAt, nowIso, MAX_AGE_DAYS);

  if (!force && cached && !stale) return { text: readFileSync(CACHE_CSV, 'utf8'), staleDays: 0, meta };
  try {
    return { text: await refreshRegister(), staleDays: 0, meta: JSON.parse(readFileSync(CACHE_META, 'utf8')) };
  } catch (err) {
    if (!cached) throw err;
    const days = meta ? Math.floor((Date.parse(nowIso) - Date.parse(meta.fetchedAt)) / 86400000) : null;
    console.error(`sponsor-check: rafraichissement impossible (${err.message}) — cache utilise`);
    return { text: readFileSync(CACHE_CSV, 'utf8'), staleDays: days, meta };
  }
}

async function main(argv) {
  const args = argv.slice(2);
  // Ordre impose par validateFlags : le flag inconnu est rejete AVANT tout
  // traitement de --help/--self-test, et donc avant que le premier argument
  // non-flag ne puisse etre pris pour la requete (finding 1). Sur flag
  // inconnu ou --help, validateFlags imprime et appelle process.exit() elle-meme.
  validateFlags(args, KNOWN_FLAGS, USAGE);
  if (hasFlag(args, '--self-test')) return selfTest();

  // '-' (simple tiret), pas seulement '--' : un flag a un seul tiret est deja
  // rejete plus haut par validateFlags s'il n'est pas connu, mais ce filtre
  // reste la derniere ligne de defense pour qu'aucun token commencant par
  // '-' ne devienne jamais la requete.
  const query = args.find((a) => !a.startsWith('-'));
  if (!query || !query.trim()) { console.error(`sponsor-check: nom d'entreprise manquant\n\n${USAGE}`); return 1; }

  const nowIso = new Date().toISOString();
  let register;
  try {
    register = await loadRegister(hasFlag(args, '--refresh'), nowIso);
  } catch (err) {
    // Meme forme que les trois autres statuts (finding 5) : un consommateur
    // qui lit registerRows/staleDays sans garde ne doit jamais casser ici.
    const out = { status: 'unavailable', query, shortQuery: false, entities: [], reason: err.message, registerRows: 0, staleDays: null };
    console.log(hasFlag(args, '--summary')
      ? `${query} : registre indisponible — ${err.message}`
      : JSON.stringify(out, null, 2));
    return 1;
  }

  const rows = parseRegisterCsv(register.text);
  const result = { ...classifySponsorship(query, rows), registerRows: rows.length, staleDays: register.staleDays };

  if (!hasFlag(args, '--summary')) { console.log(JSON.stringify(result, null, 2)); return 0; }

  console.log(`${query} → ${result.status}${result.shortQuery ? '  (requête courte, à pondérer)' : ''}`);
  for (const e of result.entities) {
    const cityLabel = e.cities && e.cities.length > 1 ? e.cities.join(' / ') : (e.city || 'ville inconnue');
    const ratingLabel = e.ratings && e.ratings.length ? e.ratings.join(' / ') : e.rating;
    console.log(`  ${e.name} — ${cityLabel} — ${ratingLabel}`);
    for (const r of e.routes) console.log(`      route : ${r}`);
  }
  if (result.status === 'not-listed') console.log(`  Absent du registre. Cela veut dire "inconnu", pas "non-sponsor".`);
  if (result.staleDays) console.log(`  (cache vieux de ${result.staleDays} j)`);
  console.log(`  ${result.registerRows} entrées lues.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => process.exit(code));
}
