/**
 * Dedicated Web Worker entry for the SVR compute phase.
 *
 * The reconstruction solve is minutes of pure typed-array number crunching;
 * running it here keeps the main thread fully interactive instead of relying
 * on cooperative yieldToMain() gaps. The worker is single-shot: the main
 * thread spawns one per reconstruction, sends a single 'run' message (with the
 * decoded slice pixel buffers in the transfer list, so no copy is paid), and
 * terminates the worker once a 'done'/'error' arrives or the user aborts.
 *
 * Protocol (types in svrComputeCore.ts, shared with the main-thread dispatcher):
 *   main → worker: { type: 'run', payload }  — start the compute phase
 *                  { type: 'abort' }         — cooperative cancellation
 *   worker → main: { type: 'progress', progress }   — forwarded onProgress calls
 *                  { type: 'done', volume, ... }    — volume buffer transferred back
 *                  { type: 'error', message }       — compute threw (incl. 'SVR cancelled')
 *
 * Abort works because computeSvrFromLoadedSlices awaits yieldToMain()
 * throughout: each yield lets this worker's event loop deliver the 'abort'
 * message, which flips the AbortController below; the next assertNotAborted
 * check then throws 'SVR cancelled'. The main thread additionally terminate()s
 * the worker on abort, so even a yield-starved loop cannot outlive the user's
 * cancel.
 */

import type { SvrComputeWorkerRequest, SvrComputeWorkerResponse } from './svrComputeCore';
import { computeSvrFromLoadedSlices } from './svrComputeCore';

// The project compiles against DOM lib types (no WebWorker lib), where `self`
// is typed as Window. Narrow to the dedicated-worker surface we actually use.
const workerScope = self as unknown as {
  postMessage(message: SvrComputeWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

// One controller per worker lifetime (single-shot protocol): 'abort' simply
// flips it, and the in-flight compute observes the signal at its yield points.
const abortController = new AbortController();
let started = false;

async function run(payload: Extract<SvrComputeWorkerRequest, { type: 'run' }>['payload']): Promise<void> {
  try {
    const result = await computeSvrFromLoadedSlices({
      ...payload,
      signal: abortController.signal,
      onProgress: (progress) => {
        workerScope.postMessage({ type: 'progress', progress });
      },
    });

    // Transfer (not copy) the volume back: for large grids this is a
    // multi-hundred-MiB Float32Array, and the worker is about to be
    // terminated anyway, so handing over ownership is free.
    workerScope.postMessage(
      {
        type: 'done',
        volume: result.volume,
        observedSupport: result.observedSupport,
        supportedVoxelCount: result.supportedVoxelCount,
        acquiredOrientationCount: result.acquiredOrientationCount,
        ...(result.effectiveResolutionMm ? { effectiveResolutionMm: result.effectiveResolutionMm } : {}),
        sliceProfileSource: result.sliceProfileSource,
        reconstructionFingerprint: result.reconstructionFingerprint,
        dims: result.dims,
        originMm: result.originMm,
        voxelSizeMm: result.voxelSizeMm,
        bounds: result.bounds,
      },
      [result.volume.buffer as ArrayBuffer, result.observedSupport.buffer as ArrayBuffer],
    );
  } catch (err) {
    // Errors don't propagate across the worker boundary on their own; report
    // the message so the main thread can reject with the same semantics as the
    // inline path (abort surfaces here as the 'SVR cancelled' Error from
    // assertNotAborted).
    workerScope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

workerScope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as SvrComputeWorkerRequest;

  if (msg.type === 'abort') {
    abortController.abort();
    return;
  }

  if (msg.type === 'run') {
    // Single-shot: ignore duplicate 'run' messages rather than racing two
    // computes over the same (already transferred) slice buffers.
    if (started) return;
    started = true;
    void run(msg.payload);
  }
};
