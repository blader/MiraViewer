/// <reference lib="webworker" />
import {
  renderSharpSlicePresentation,
  type SharpSliceDisplayResult,
  type SharpSlicePresentationInput,
} from './sharpSlicePresentation';

export type SharpSliceWorkerRequest = { type: 'render'; input: SharpSlicePresentationInput };
export type SharpSliceWorkerResponse =
  | { type: 'progress'; message: string }
  | { type: 'image'; image: SharpSliceDisplayResult }
  | { type: 'error'; message: string };

self.onmessage = async (event: MessageEvent<SharpSliceWorkerRequest>) => {
  try {
    if (event.data.type === 'render') {
      const image = await renderSharpSlicePresentation(event.data.input, {
        onProgress: (message) => self.postMessage({ type: 'progress', message } satisfies SharpSliceWorkerResponse),
      });
      self.postMessage({ type: 'image', image } satisfies SharpSliceWorkerResponse, [
        image.pixels.buffer,
        image.valid.buffer,
      ]);
    } else throw new Error('Unknown sharp-slice operation.');
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Sharp-slice reconstruction failed.',
    } satisfies SharpSliceWorkerResponse);
  }
};
