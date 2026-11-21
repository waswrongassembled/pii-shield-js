import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

/** The ```ts blocks of a Markdown file. */
function tsBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? '');
}

describe('README and docs/stores.md examples', () => {
  it('type-check against the source', { timeout: 120_000 }, async () => {
    const readme = tsBlocks(await readFile(join(root, 'README.md'), 'utf8'));
    const stores = tsBlocks(await readFile(join(root, 'docs', 'stores.md'), 'utf8'));
    expect(readme.length).toBeGreaterThanOrEqual(8);
    expect(stores.length).toBeGreaterThanOrEqual(3);
    const blocks = [...readme, ...stores];

    // Inside the repo, so that node_modules (ai, ioredis, pg, the MCP SDK) resolve; ignored by git and lint.
    const dir = await mkdtemp(join(root, '.readme-examples-'));
    try {
      await Promise.all(
        blocks.map((code, i) => writeFile(join(dir, `example-${String(i + 1)}.ts`), `${code}\nexport {};\n`)),
      );
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          extends: '../tsconfig.json',
          compilerOptions: {
            noEmit: true,
            rootDir: '..',
            // The repo's extra strictness, not what users need for these snippets.
            noPropertyAccessFromIndexSignature: false,
            paths: {
              '@waswrongassembled/pii-shield': ['../src/index.ts'],
              '@waswrongassembled/pii-shield/*': ['../src/*/index.ts'],
            },
          },
          include: ['*.ts'],
        }),
      );
      const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
      const result = await promisify(execFile)(process.execPath, [tsc, '-p', dir], { cwd: root }).then(
        () => '',
        (e: unknown) => (e as { stdout?: string }).stdout ?? String(e),
      );
      expect(result).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
