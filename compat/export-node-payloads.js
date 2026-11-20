/*
 * Writes vault payloads produced by the Node port (dist/, run `npm run build` first) to a JSON file, so
 * compat/decrypt-node-payload.php can prove that PHP's EncryptedVault reads them.
 *
 * Usage:
 *   node compat/export-node-payloads.js <out-file>
 *
 * Every case uses a fresh random key and the real code path (random nonce). The output holds the keys:
 * write it to a temp directory and do not commit it. All data is synthetic.
 */
import { writeFileSync } from 'node:fs';

import { EncryptedVault, generateVaultKey, MemoryVaultStorage, PiiShield } from '../dist/index.js';

const outFile = process.argv[2];
if (outFile === undefined) {
  process.stderr.write('Usage: node compat/export-node-payloads.js <out-file>\n');
  process.exit(1);
}

const mappings = {
  'empty mapping': {},
  escaping: {
    '⟦OTHER_1⟧': `"quoted" / back\\slash \u{2028} <tag> é 😀 \t \u{0} \u{1F} \u{7F} &'`,
    '⟦OTHER_2⟧': 'Straße 1/2\r\nÖsterreich',
  },
  'learned type name': { '⟦AKTEN_ZAHL_1⟧': 'AZ 12/2026', '⟦PERSON_10⟧': 'Max Mustermann' },
  'integer-like value': { '⟦OTHER_1⟧': '42' },
};

const cases = [];
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

for (const [name, mapping] of Object.entries(mappings)) {
  const storage = new MemoryVaultStorage();
  const key = generateVaultKey();
  const id = `node-${name.replaceAll(' ', '-')}`;
  await new EncryptedVault({ storage, key }).store(id, mapping, 60);
  cases.push({ case: name, key: toBase64(key), id, mapping, payload: toBase64(await storage.get(id)) });
}

// The full pipeline: PiiShield.redactToVault() with a random vault id.
{
  const storage = new MemoryVaultStorage();
  const key = generateVaultKey();
  const result = await new PiiShield({ vault: new EncryptedVault({ storage, key }) }).redactToVault(
    'Frau\nMaria Musterfrau\nLindenweg 12\n6900 Bregenz\nIBAN AT61 1904 3002 3457 3201, SVNR 4568 150392, 😀',
  );
  cases.push({
    case: 'redactToVault',
    key: toBase64(key),
    id: result.vaultId,
    mapping: result.mapping,
    payload: toBase64(await storage.get(result.vaultId)),
  });
}

writeFileSync(outFile, `${JSON.stringify({ generatedBy: 'compat/export-node-payloads.js', cases }, null, 2)}\n`);
process.stdout.write(`wrote ${String(cases.length)} cases to ${outFile}\n`);
