import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo paths
const frontendRoot = path.resolve(__dirname, '..');
const distDir = path.join(frontendRoot, 'dist');
const templatesDir = path.join(frontendRoot, 'distribution');

// Output paths
const releaseDir = path.join(frontendRoot, 'release');
const stagingDir = path.join(releaseDir, 'MiraViewer');
const zipName = 'MiraViewer.zip';

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    ...opts,
  });

  if (res.error) {
    // Provide a clearer error than the default when a command is missing.
    if (res.error && typeof res.error === 'object' && 'code' in res.error && res.error.code === 'ENOENT') {
      throw new Error(`Command not found: ${cmd}. Ensure it is installed and available on your PATH.`);
    }
    throw res.error;
  }
  if (typeof res.status === 'number' && res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${res.status}`);
  }
}

function copyDirContents(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });

  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(destDir, entry.name);

    // Node 20+: cpSync handles files/dirs; we keep it explicit so behavior is clear.
    cpSync(src, dst, { recursive: true });
  }
}

function main() {
  // Fresh output each run.
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // 1) Build production assets (includes vendored /pipelines via viteStaticCopy).
  run('npm', ['run', 'build'], { cwd: frontendRoot });

  // 2) Stage the runnable folder.
  copyDirContents(distDir, stagingDir);
  copyDirContents(templatesDir, stagingDir);

  // 3) Zip it up. We prefer the system zip so executable bits (start.command/start.sh)
  // are preserved.
  run('zip', ['-r', zipName, 'MiraViewer'], { cwd: releaseDir });

  console.log(`[package] Wrote ${path.join(releaseDir, zipName)}`);
}

main();
