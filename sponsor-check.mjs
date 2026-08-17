#!/usr/bin/env node
import { pathToFileURL } from 'url';
import { hasFlag } from './lib/cli-flags.mjs';
import { normalizeName, tokenize } from './sponsor-core.mjs';

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
