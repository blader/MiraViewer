/// <reference lib="webworker" />
import type { SvrVolume } from '../../types/svr';
import { enhanceVolume2x } from './superResolution';
import type { SvrSuperResolutionWorkerResponse } from './superResolutionTypes';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = ({ data }: MessageEvent<SvrVolume>) => {
  void enhanceVolume2x(data, {
    onProgress: (progress) =>
      self.postMessage({ type: 'progress', progress } satisfies SvrSuperResolutionWorkerResponse),
  }).then(
    (result) =>
      self.postMessage({ type: 'done', result } satisfies SvrSuperResolutionWorkerResponse, [
        result.data.buffer,
        result.observedSupport.buffer,
      ]),
    (error: unknown) =>
      self.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies SvrSuperResolutionWorkerResponse),
  );
};
