import { BRATS_LABEL_ID } from '../brats';

const REQUIRED_CLASSES = [
  { index: 0, labelId: BRATS_LABEL_ID.BACKGROUND, anatomy: 'background' },
  { index: 1, labelId: BRATS_LABEL_ID.NCR_NET, anatomy: 'tumor-core' },
  { index: 2, labelId: BRATS_LABEL_ID.EDEMA, anatomy: 'edema' },
  { index: 3, labelId: BRATS_LABEL_ID.ENHANCING, anatomy: 'enhancing-tumor' },
] as const;

export type TumorModelManifest = {
  version: 1;
  modality: 'MR';
  normalization: 'svr-normalized-0-1';
  input: {
    channels: 1;
    axes: 'NCZYX';
    /** Legacy manifests use isotropic patient LPS; native input requires explicit acceptance of its axes and pitch. */
    spatialFrame?: 'patient-lps' | 'source-grid';
  };
  classes: ReadonlyArray<{ index: number; labelId: number; anatomy: string }>;
  modelSha256: string;
};

export const TUMOR_MODEL_MANIFEST_EXAMPLE: TumorModelManifest = {
  version: 1,
  modality: 'MR',
  normalization: 'svr-normalized-0-1',
  input: { channels: 1, axes: 'NCZYX' },
  classes: REQUIRED_CLASSES,
  modelSha256: '<64-character lowercase SHA-256 of the .onnx file>',
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function verifyTumorModelManifest(
  model: Blob,
  sidecar: Blob | null | undefined,
): Promise<TumorModelManifest> {
  if (!sidecar) {
    throw new Error('Model is unverified. Upload the .onnx model together with its SHA-256-bound .json manifest.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await sidecar.arrayBuffer())) as unknown;
  } catch {
    throw new Error('The model manifest is not valid JSON.');
  }

  const manifest = object(raw);
  if (!manifest || manifest.version !== 1) throw new Error('The model manifest must declare version 1.');
  if (manifest.modality !== 'MR') throw new Error('The model manifest must declare MR source modality.');
  if (manifest.normalization !== 'svr-normalized-0-1') {
    throw new Error('The model manifest must declare svr-normalized-0-1 preprocessing.');
  }

  const input = object(manifest.input);
  if (!input || input.channels !== 1 || input.axes !== 'NCZYX') {
    throw new Error('The model manifest must declare one input channel with NCZYX spatial axes.');
  }
  if (input.spatialFrame !== undefined && input.spatialFrame !== 'patient-lps' && input.spatialFrame !== 'source-grid')
    throw new Error('The model manifest spatialFrame must be patient-lps or source-grid.');

  if (!Array.isArray(manifest.classes) || manifest.classes.length !== REQUIRED_CLASSES.length) {
    throw new Error('The model manifest must declare all four tumor class semantics.');
  }
  for (let index = 0; index < REQUIRED_CLASSES.length; index++) {
    const expected = REQUIRED_CLASSES[index]!;
    const actual = object(manifest.classes[index]);
    if (
      !actual ||
      actual.index !== expected.index ||
      actual.labelId !== expected.labelId ||
      actual.anatomy !== expected.anatomy
    ) {
      throw new Error(`The model manifest has an unsupported semantic mapping for class ${index}.`);
    }
  }

  if (typeof manifest.modelSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.modelSha256)) {
    throw new Error('The model manifest must contain the lowercase SHA-256 hash of its ONNX file.');
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error('Model verification requires Web Crypto on a secure localhost origin.');
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', await model.arrayBuffer());
  const actualHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actualHash !== manifest.modelSha256) {
    throw new Error('The model manifest SHA-256 does not match the selected ONNX file.');
  }

  return {
    version: 1,
    modality: 'MR',
    normalization: 'svr-normalized-0-1',
    input: {
      channels: 1,
      axes: 'NCZYX',
      ...(input.spatialFrame === undefined ? {} : { spatialFrame: input.spatialFrame }),
    },
    classes: REQUIRED_CLASSES,
    modelSha256: actualHash,
  };
}
