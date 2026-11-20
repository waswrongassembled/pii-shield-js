import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { describe, expect, it } from 'vitest';

import { codePointSlice, FIXTURE_NAMES, loadFixture } from './support/fixtures.js';

describe('fixtures', () => {
  it.each(FIXTURE_NAMES)('%s.json comes from a clean PHP checkout', (name) => {
    const fixture = loadFixture(name);

    expect(fixture.generatedBy).toBe('compat/export-fixtures.php');
    expect(fixture.phpSource).toMatch(/^[0-9a-f]{40}$/);
  });

  it('contains the synthetic letters', () => {
    expect(loadFixture('letters').letters.length).toBeGreaterThan(0);
  });

  it('reports offsets and lengths in code points', () => {
    const spans = [
      ...loadFixture('detectors').cases.map((c) => ({ text: c.text, entities: c.entities })),
      ...loadFixture('redaction').cases.map((c) => ({ text: c.text, entities: c.redaction.entities })),
    ];
    const astral = spans.filter((s) => /\p{Extended_Pictographic}/u.test(s.text) && s.entities.length > 0);

    expect(astral.length).toBeGreaterThan(0);
    for (const { text, entities } of spans) {
      for (const e of entities) {
        expect(codePointSlice(text, e.offset, e.length)).toBe(e.value);
      }
    }
  });

  it('vault payloads decrypt with @noble/ciphers (nonce(24) || XChaCha20-Poly1305, AAD = vault id)', () => {
    const vault = loadFixture('vault');
    const key = Buffer.from(vault.key, 'base64');

    for (const p of vault.payloads) {
      const payload = Buffer.from(p.payload, 'base64');
      const plaintext = xchacha20poly1305(key, payload.subarray(0, 24), Buffer.from(p.id, 'utf8')).decrypt(
        payload.subarray(24),
      );
      const text = Buffer.from(plaintext).toString('utf8');

      expect(text).toBe(p.plaintext);
      // PHP encodes an empty mapping as "[]", not "{}": the port must read both.
      expect(text === '[]' ? {} : JSON.parse(text)).toEqual(p.mapping);
    }
  });
});
