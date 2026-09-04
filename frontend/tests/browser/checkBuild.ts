import { readFileSync } from 'node:fs';
import { sourceRevision } from '../../scripts/build-browser.mjs';

export default function checkBuild() {
  const built = JSON.parse(readFileSync(new URL('../../tmp/browser-dist/browser-build.json', import.meta.url), 'utf8'));
  const current = sourceRevision();
  if (built.sourceSha256 !== current.sourceSha256 || built.modelManifestSha256 !== current.modelManifestSha256)
    throw new Error('Browser build is stale. Run npm run build:browser before this acceptance check.');
}
