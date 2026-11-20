/*
 * Smoke test of the published package: packs it, installs the tarball into a temp project (preferring the npm cache, from
 * the npm cache that `npm ci` filled) and checks that every export subpath loads with `import` and
 * `require()` (require(esm), Node >= 22.12), that the types resolve with `tsc` (NodeNext), that the
 * server finds docs/openapi.yaml from the installed path and that `npx pii-shield --help` runs.
 *
 * Usage: npm run test:package (builds first). PII_SHIELD_KEEP_TMP=1 keeps the temp project.
 * All data is synthetic.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const subpaths = Object.keys(pkg.exports)
  .filter((p) => p !== './package.json')
  .map((p) => (p === '.' ? pkg.name : `${pkg.name}/${p.slice(2)}`));
// Optional peer dependencies (and @types/node for the type check), installed at the version the repo tests against.
const peers = [...Object.keys(pkg.peerDependencies), '@types/node'].map((name) => {
  const { version } = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
  return `${name}@${version}`;
});

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const dir = mkdtempSync(join(tmpdir(), 'pii-shield-package-'));
try {
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', dir], root));
  const tarball = join(dir, packed.filename);
  const files = packed.files.map((f) => f.path);
  const unexpected = files.filter(
    (f) =>
      !/^dist\/.+\.(js|d\.ts)$/.test(f) &&
      !['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs/openapi.yaml'].includes(f),
  );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected files in the tarball: ${unexpected.join(', ')}`);
  }
  const required = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'docs/openapi.yaml', 'dist/bin.js'];
  const missing = required.filter((f) => !files.includes(f));
  if (missing.length > 0) {
    throw new Error(`Missing in the tarball: ${missing.join(', ')}`);
  }
  console.log(`packed ${packed.filename}: ${files.length} files, ${packed.size} bytes`);

  const project = join(dir, 'project');
  run('mkdir', ['-p', project], dir);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  run(npm, ['install', '--prefer-offline', '--no-audit', '--no-fund', '--no-package-lock', tarball, ...peers], project);

  writeFileSync(
    join(project, 'esm.js'),
    `import assert from 'node:assert/strict';
const subpaths = ${JSON.stringify(subpaths)};
for (const s of subpaths) {
  const m = await import(s);
  assert.ok(Object.keys(m).length > 0, s);
}
const { PiiShield } = await import(${JSON.stringify(pkg.name)});
const shield = new PiiShield();
const result = shield.redact('IBAN AT61 1904 3002 3457 3201');
assert.equal(result.redactedText, 'IBAN \\u{27E6}IBAN_1\\u{27E7}');
assert.equal(shield.restore(result.redactedText, result).text, 'IBAN AT61 1904 3002 3457 3201');
const { openapiDocument } = await import(${JSON.stringify(`${pkg.name}/server`)});
assert.match(await openapiDocument(), /^openapi: /m);
console.log('esm ok');
`,
  );
  writeFileSync(
    join(project, 'cjs.cjs'),
    `const assert = require('node:assert/strict');
for (const s of ${JSON.stringify(subpaths)}) {
  assert.ok(Object.keys(require(s)).length > 0, s);
}
const { PiiShield } = require(${JSON.stringify(pkg.name)});
assert.equal(new PiiShield().redact('IBAN AT61 1904 3002 3457 3201').redactedText, 'IBAN \\u{27E6}IBAN_1\\u{27E7}');
console.log('cjs ok');
`,
  );
  writeFileSync(
    join(project, 'types.ts'),
    `${subpaths.map((s, i) => `import * as m${i} from '${s}';`).join('\n')}
import { PiiShield, type RedactionResult } from '${pkg.name}';
const result: RedactionResult = new PiiShield().redact('');
export const all = [${subpaths.map((_, i) => `m${i}`).join(', ')}, result.redactedText];
`,
  );
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2024',
        strict: true,
        noEmit: true,
        // Third-party declarations (e.g. ai's json-schema import) are not ours to check; ours are checked by the build.
        skipLibCheck: true,
        types: ['node'],
      },
      files: ['types.ts'],
    }),
  );

  process.stdout.write(run(process.execPath, ['esm.js'], project));
  process.stdout.write(run(process.execPath, ['--no-warnings', 'cjs.cjs'], project));
  run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', '.'], project);
  console.log('types ok');
  // The CLI writes its usage to stderr (stdout belongs to the MCP STDIO transport).
  const help = spawnSync(npx, ['--offline', 'pii-shield', '--help'], { cwd: project, encoding: 'utf8' });
  if (help.status !== 0 || !help.stderr.startsWith('Usage:')) {
    throw new Error(`Unexpected --help result (exit ${help.status}): ${help.stderr}`);
  }
  console.log('bin ok');
} finally {
  if (process.env.PII_SHIELD_KEEP_TMP === '1') {
    console.log(`kept ${dir}`);
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}
