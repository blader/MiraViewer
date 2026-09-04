import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function sourceRevision() {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== '__pycache__') visit(path);
      else if (entry.isFile() && /\.(?:tsx?|m?js|json|html|css|py|sh|bat|command)$/.test(path)) paths.push(path);
    }
  };
  for (const directory of ['src', 'tests', 'scripts', 'distribution']) visit(directory);
  paths.push('package.json', 'package-lock.json', 'vite.config.ts', 'playwright.config.ts', 'index.html');
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceSha256: hash(
      paths
        .sort()
        .map((path) => `${path}:${hash(readFileSync(resolve(root, path)))}`)
        .join('\n'),
    ),
    modelManifestSha256: hash(readFileSync(resolve(root, 'src/utils/segmentation/efficientTam/assetManifest.json'))),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const before = sourceRevision();
  const { build } = await import('vite');
  await build({ root, mode: 'browser-test', build: { outDir: 'tmp/browser-dist', emptyOutDir: true } });
  const after = sourceRevision();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Source changed during browser build. Rebuild before testing.');
  writeFileSync(
    resolve(root, 'tmp/browser-dist/browser-build.json'),
    JSON.stringify(
      {
        ...after,
        builtAt: new Date().toISOString(),
        fixture: 'synthetic only',
      },
      null,
      2,
    ),
  );
}
