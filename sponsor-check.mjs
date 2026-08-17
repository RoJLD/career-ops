#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { hasFlag } from './lib/cli-flags.mjs';
import { normalizeName, tokenize, parseCsvLine, parseRegisterCsv, matchEntities, classifySponsorship } from './sponsor-core.mjs';

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

  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passés`);
  return failed === 0 ? 0 : 1;
}

function main(argv) {
  const args = argv.slice(2);
  if (hasFlag(args, '--self-test')) return selfTest();
  console.log('sponsor-check: pas encore implémenté');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv));
