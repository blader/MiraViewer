import { describe, expect, it, vi } from 'vitest';

// Mock ORT loader to avoid pulling real onnxruntime-web + wasm during unit tests.
vi.mock('../src/utils/segmentation/onnx/ortLoader', () => {
  class Tensor {
    type: string;
    data: unknown;
    dims: number[];

    constructor(type: string, data: unknown, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }

  return {
    loadOrtAll: async () => ({ Tensor, env: { wasm: {} } }),
  };
});

import { runTumorSegmentationOnnx } from '../src/utils/segmentation/onnx/tumorSegmentation';

describe('runTumorSegmentationOnnx', () => {
  it('feeds [1,1,Z,Y,X] tensor and converts logits to labels', async () => {
    const dims: [number, number, number] = [2, 1, 1]; // nx=2, ny=1, nz=1
    const volume = new Float32Array([0.1, 0.9]);

    // 4 classes (0,1,2,4) and spatial=2
    // logits layout: [C, spatial]
    // voxel0 -> class1, voxel1 -> class3
    const logits = new Float32Array([
      // c0
      0, 0,
      // c1
      5, 0,
      // c2
      0, 0,
      // c3
      0, 7,
    ]);

    const session = {
      inputNames: ['input'],
      outputNames: ['logits'],
      run: vi.fn(async (feeds: Record<string, any>) => {
        expect(Object.keys(feeds)).toEqual(['input']);
        expect(feeds.input.type).toBe('float32');
        expect(feeds.input.dims).toEqual([1, 1, 1, 1, 2]); // [N,C,Z,Y,X]

        return {
          logits: {
            type: 'float32',
            dims: [1, 4, 1, 1, 2],
            data: logits,
          },
        };
      }),
    } as any;

    const out = await runTumorSegmentationOnnx({ session, volume, dims });
    expect(Array.from(out.labels)).toEqual([1, 4]);
  });
});
