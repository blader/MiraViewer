import { createHash } from 'node:crypto';
import { constants, createReadStream, readFileSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestBytes = readFileSync(path.join(frontendRoot, 'src/utils/segmentation/efficientTam/assetManifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Verify a flat allowlist without copying, downloading, or opening a model session. */
export async function verifyAssetFiles(directory, records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('The asset allowlist must not be empty.');
  const allowed = new Set();
  for (const record of records) {
    if (!record || typeof record.path !== 'string' || !safeName.test(record.path))
      throw new Error('Every asset needs a safe relative filename, without directories or URL escapes.');
    if (
      !Number.isSafeInteger(record.bytes) ||
      record.bytes <= 0 ||
      typeof record.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    )
      throw new Error(`Invalid byte count or SHA-256 for asset: ${record.path}`);
    if (allowed.has(record.path)) throw new Error(`Duplicate asset filename: ${record.path}`);
    allowed.add(record.path);
  }

  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The asset directory must be a real directory.');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) throw new Error(`Unexpected file in model asset directory: ${entry.name}`);
    if (!entry.isFile())
      throw new Error(`Model asset must be a regular file, not a directory or symlink: ${entry.name}`);
  }

  let bytes = 0;
  for (const record of records) {
    const filename = path.join(directory, record.path);
    const info = await lstat(filename).catch((error) => {
      if (error.code === 'ENOENT') throw new Error(`Missing model asset: ${record.path}. No download was attempted.`);
      throw error;
    });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Model asset must be a regular file: ${record.path}`);
    if (info.size !== record.bytes) {
      if (info.size < 1024 && readFileSync(filename, 'utf8').startsWith('version https://git-lfs.github.com/spec/v1\n'))
        throw new Error(
          `Model asset is an unresolved Git LFS pointer: ${record.path}. Run git lfs install and git lfs pull before building; enable Git LFS in hosted Git settings.`,
        );
      throw new Error(`Model asset byte count mismatch: ${record.path}`);
    }
    const hash = createHash('sha256');
    let readBytes = 0;
    // Do not retain a second full model copy while verifying a build directory.
    for await (const chunk of createReadStream(filename, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) {
      hash.update(chunk);
      readBytes += chunk.length;
    }
    if (readBytes !== record.bytes || hash.digest('hex') !== record.sha256)
      throw new Error(`Model asset SHA-256 mismatch: ${record.path}`);
    bytes += readBytes;
  }
  return { files: records.length, bytes };
}

/** The application manifest is the authority; no directory-supplied sidecar can replace its pins. */
export async function verifyEfficientTamAssets(directory = path.join(frontendRoot, 'public', manifest.directory)) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.task !== 'interactive-binary-2d-tracking' ||
    !manifest.directory.split('/').every((part) => safeName.test(part))
  )
    throw new Error('Unsupported EfficientTAM asset manifest.');
  const models = [...Object.values(manifest.graphs), ...Object.values(manifest.constants)];
  if (models.length !== 6 || models.reduce((total, record) => total + record.bytes, 0) !== manifest.totalModelBytes)
    throw new Error('The EfficientTAM manifest must account for exactly six model assets.');
  for (const tensor of Object.values(manifest.constants)) {
    if (
      tensor.dtype !== 'float32-le' ||
      !Array.isArray(tensor.shape) ||
      !tensor.shape.length ||
      !tensor.shape.every((value) => Number.isSafeInteger(value) && value > 0) ||
      tensor.shape.reduce((total, value) => total * value, 4) !== tensor.bytes
    )
      throw new Error(`Invalid positional tensor layout: ${tensor.path}`);
  }
  const verified = await verifyAssetFiles(directory, [...models, ...Object.values(manifest.notices)]);
  return {
    model: manifest.id,
    directory: path.resolve(directory),
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    modelBytes: manifest.totalModelBytes,
    ...verified,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0]?.startsWith('-')) {
    console.error('Usage: node scripts/verify-efficient-tam-assets.mjs [model-directory]');
    process.exitCode = 1;
  } else {
    verifyEfficientTamAssets(args[0])
      .then((verified) => console.log(JSON.stringify(verified)))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
