import type * as Ort from 'onnxruntime-web';
import { BRATS_LABEL_ID } from '../brats';
import { loadOrtAll } from './ortLoader';
import { logitsToLabels } from './logitsToLabels';

export type TumorOnnxSegmentationResult = {
  /** Flattened label IDs (length = nx*ny*nz). */
  labels: Uint8Array;
  /** The output logits dims returned by the model. */
  logitsDims: readonly number[];
};

function assertSupportedModelMetadata(
  session: Ort.InferenceSession,
  expectedSpatial: readonly [number, number, number],
  expectedClasses: number,
): void {
  const [nx, ny, nz] = expectedSpatial;
  const validate = (
    metadata: Ort.InferenceSession.ValueMetadata | undefined,
    expectedShape: readonly number[],
    label: string,
  ) => {
    if (!metadata) return;
    if (!metadata.isTensor || metadata.type !== 'float32') {
      throw new Error(`Unsupported ONNX ${label}: expected a float32 tensor`);
    }
    if (metadata.shape.length !== expectedShape.length) {
      throw new Error(`Unsupported ONNX ${label} layout: expected ${expectedShape.length} tensor dimensions`);
    }
    for (let i = 0; i < expectedShape.length; i++) {
      const actual = metadata.shape[i];
      if (typeof actual === 'number' && actual > 0 && actual !== expectedShape[i]) {
        throw new Error(`Unsupported ONNX ${label} shape at axis ${i}: expected ${expectedShape[i]}, got ${actual}`);
      }
    }
  };

  validate(session.inputMetadata?.[0], [1, 1, nz, ny, nx], 'input');
  validate(session.outputMetadata?.[0], [1, expectedClasses, nz, ny, nx], 'output');
}

export async function runTumorSegmentationOnnx(params: {
  session: Ort.InferenceSession;
  volume: Float32Array;
  dims: [number, number, number];
  /** Override model input name. Defaults to first session input. */
  inputName?: string;
  /** Override model output name. Defaults to first session output. */
  outputName?: string;
  /** Map class index -> label id. Default assumes 4 classes [0,1,2,4]. */
  labelMap?: readonly number[];
}): Promise<TumorOnnxSegmentationResult> {
  const { session, volume, dims } = params;
  const [nx, ny, nz] = dims;

  const ort = await loadOrtAll();

  const inputName = params.inputName ?? session.inputNames[0];
  const outputName = params.outputName ?? session.outputNames[0];
  if (!inputName) {
    throw new Error('ONNX session has no inputs');
  }
  if (!outputName) {
    throw new Error('ONNX session has no outputs');
  }

  const labelMap = params.labelMap ?? [
    BRATS_LABEL_ID.BACKGROUND,
    BRATS_LABEL_ID.NCR_NET,
    BRATS_LABEL_ID.EDEMA,
    BRATS_LABEL_ID.ENHANCING,
  ];
  assertSupportedModelMetadata(session, dims, labelMap.length);

  // ORT expects NCHW-like layout for 3D conv models: [N, C, Z, Y, X].
  // Our Float32Array is already in X-fastest order, so [Z,Y,X] is consistent.
  const inputTensor = new ort.Tensor('float32', volume, [1, 1, nz, ny, nx]);

  const outputs = await session.run({ [inputName]: inputTensor } as Record<string, Ort.Tensor>);
  const logitsTensor = outputs[outputName];
  if (!logitsTensor) {
    throw new Error(`ONNX run did not return expected output: ${outputName}`);
  }

  if (logitsTensor.type !== 'float32') {
    throw new Error(`Unsupported logits tensor type: ${logitsTensor.type}`);
  }

  const logitsDims = logitsTensor.dims;
  let labels: Uint8Array;
  let spatialDims: [number, number, number];
  try {
    ({ labels, spatialDims } = logitsToLabels({
      logits: { data: logitsTensor.data as Float32Array, dims: logitsDims },
      labelMap,
    }));
  } finally {
    // Release GPU-backed logits even when an incompatible model is rejected.
    try {
      (logitsTensor as { dispose?: () => void }).dispose?.();
    } catch {
      // CPU-located tensors do not necessarily expose explicit disposal.
    }
  }

  // Sanity check that the model output matches the current SVR volume.
  const expected = nx * ny * nz;
  if (labels.length !== expected) {
    throw new Error(`Model output spatial size mismatch (expected ${expected}, got ${labels.length}).`);
  }

  if (spatialDims[0] !== nx || spatialDims[1] !== ny || spatialDims[2] !== nz) {
    throw new Error(
      `Model output spatial axes do not match the reconstructed volume ` +
        `(expected ${nx}×${ny}×${nz}, got ${spatialDims.join('×')}).`,
    );
  }

  return { labels, logitsDims };
}
