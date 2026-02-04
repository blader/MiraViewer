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

  const labelMap = params.labelMap ?? [BRATS_LABEL_ID.BACKGROUND, BRATS_LABEL_ID.NCR_NET, BRATS_LABEL_ID.EDEMA, BRATS_LABEL_ID.ENHANCING];

  const { labels, spatialDims } = logitsToLabels({
    logits: { data: logitsTensor.data as Float32Array, dims: logitsTensor.dims },
    labelMap,
  });

  // Sanity check that the model output matches the current SVR volume.
  const expected = nx * ny * nz;
  if (labels.length !== expected) {
    throw new Error(`Model output spatial size mismatch (expected ${expected}, got ${labels.length}).`);
  }

  // NOTE: spatialDims is [X,Y,Z] for convenience. This should match the SVR dims.
  if (spatialDims[0] !== nx || spatialDims[1] !== ny || spatialDims[2] !== nz) {
    // Don't fail hard: some models output in a different orientation; callers can add remapping later.
    console.warn('[onnx] Output dims differ from SVR volume dims', { spatialDims, svrDims: dims });
  }

  return { labels, logitsDims: logitsTensor.dims };
}
