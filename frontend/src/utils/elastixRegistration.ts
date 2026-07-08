import type { JsonCompatible } from 'itk-wasm';
import {
  Image,
  ImageType,
  FloatTypes,
  PixelTypes,
  InterfaceTypes,
  runPipeline,
  setPipelinesBaseUrl as setItkPipelinesBaseUrl,
  getPipelinesBaseUrl as getItkPipelinesBaseUrl,
} from 'itk-wasm';
import type { Mat2, StandardAffine2D, Vec2 } from './affine2d';
import { computeMutualInformation } from './mutualInformation';
import {
  buildElastixTransformCandidatesStd,
  chooseBestElastixTransformCandidateAboutOrigin,
  parseTransformParameterObjectToStandardAffines,
} from './elastixTransform';
import { isDebugAlignmentEnabled } from './debugAlignment';
import { inpaintExclusionRectSquare } from './imageFeatures';

function tailString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

function tryParseElastixFinalMetricFromLogs(stdout: string, stderr: string): { finalMetric?: number; samples: number } {
  // Elastix / ITK log formats can vary across versions and parameter maps.
  // We keep this intentionally heuristic and best-effort.
  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split(/\r?\n/);

  const numberRe = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

  const metricCandidates: number[] = [];

  for (const line of lines) {
    if (!/metric/i.test(line)) continue;

    const matches = line.match(numberRe);
    if (!matches || matches.length === 0) continue;

    // Heuristic: in lines that mention "metric", the last float is often the metric value.
    const last = Number(matches[matches.length - 1]);
    if (Number.isFinite(last)) {
      metricCandidates.push(last);
    }
  }

  if (metricCandidates.length === 0) {
    return { samples: 0 };
  }

  return {
    finalMetric: metricCandidates[metricCandidates.length - 1],
    samples: metricCandidates.length,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        globalThis.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
  label: string,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new Error(`${label} cancelled`));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      onAbort();
      reject(new Error(`${label} cancelled`));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function getAppPipelinesBaseUrl(): string {
  // Vite defines import.meta.env.BASE_URL in browser builds.
  // When unavailable (e.g. tests / node), fall back to root.
  const baseUrl =
    ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL as string | undefined) || '/';

  // Vite's BASE_URL normally ends with '/', but normalize just in case.
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  // Note: no trailing slash; ITK-Wasm joins with `${baseUrl}/${module}`.
  return `${normalizedBase}pipelines`;
}

let didInitElastixRuntime = false;

function initElastixRuntimeOnce(elastixModule: unknown): void {
  if (didInitElastixRuntime) return;
  didInitElastixRuntime = true;

  if (typeof window === 'undefined') return;

  // IMPORTANT: @itk-wasm/elastix defaults its pipelines base URL to a CDN.
  // In environments where external network access is blocked, this can look like
  // an infinite hang during the first registration.
  //
  // We always force same-origin pipelines (vendored via Vite static-copy) here,
  // even if app initialization hasn't done it yet.
  const pipelinesBaseUrl = getAppPipelinesBaseUrl();

  try {
    setItkPipelinesBaseUrl(pipelinesBaseUrl);
  } catch {
    // ignore
  }

  // Best-effort: also set on the elastix module directly.
  const m = elastixModule as { setPipelinesBaseUrl?: (baseUrl: string) => void; getPipelinesBaseUrl?: () => unknown };
  try {
    m.setPipelinesBaseUrl?.(pipelinesBaseUrl);
  } catch {
    // ignore
  }

  // Log once so a stuck registration can be diagnosed by just checking the console.
  try {
    const itkBase = getItkPipelinesBaseUrl();
    const elastixBase = m.getPipelinesBaseUrl?.();
    console.info('[alignment] ITK/Elastix pipelines base URL configured', {
      itkWasm: itkBase,
      elastix: elastixBase,
    });
  } catch {
    // ignore
  }
}

// We intentionally keep elastix imports dynamic so vitest/jsdom can import the app
// without eagerly evaluating WebAssembly/Worker-dependent modules.
async function importElastix() {
  const m = await import('@itk-wasm/elastix');
  initElastixRuntimeOnce(m);
  return m;
}

function assertSquareSize(pixels: Float32Array, size: number, label: string) {
  if (pixels.length !== size * size) {
    throw new Error(`${label}: expected ${size}x${size} image (got ${pixels.length} pixels)`);
  }
}

function makeItkFloat32ScalarImage(pixels: Float32Array, size: number, name: string): Image {
  const imageType = new ImageType(2, FloatTypes.Float32, PixelTypes.Scalar, 1);
  const img = new Image(imageType);
  img.name = name;
  img.size = [size, size];
  img.spacing = [1, 1];
  img.origin = [0, 0];
  img.direction = new Float64Array([1, 0, 0, 1]);
  img.data = pixels;
  return img;
}

type NormalizedRect = { x: number; y: number; width: number; height: number };

export type Elastix2DRegistrationResult = {
  /** Authoritative moving -> fixed transform in standard pixel coordinates. */
  movingToFixed: StandardAffine2D;
  /** Moving -> fixed linear matrix (about image center when applied with translatePx). */
  A: Mat2;
  /** Moving -> fixed translation in pixels (applied after the linear part, about center). */
  translatePx: Vec2;

  /** Resampled moving image (in fixed space). Useful for scoring / debugging. */
  resampledMovingPixels: Float32Array;

  /** Full elastix transform parameter object representation (typically fixed->moving). */
  transformParameterObject: JsonCompatible;

  /**
   * Quality metrics computed on (fixedPixels, resampledMovingPixels).
   *
   * Notes:
   * - NMI is commonly used as a registration quality metric and is more robust than simple
   *   correlation when intensity mappings differ.
   * - `elastixFinalMetric` is best-effort parsed from the pipeline logs.
   */
  quality: {
    mi: number;
    nmi: number;
    bins: number;
    elastixFinalMetric?: number;
    elastixMetricSamples?: number;
  };

  /** Optional log tails for debugging (only populated when debug logging is enabled). */
  elastixLogTail?: {
    stdout: string;
    stderr: string;
  };

  /** WebWorker used for computation (can be reused across calls). */
  webWorker: Worker;
};

export type ElastixAffine2DRegistrationResult = Elastix2DRegistrationResult;

type ElastixTransformKind = 'rigid' | 'affine';

type Register2DOptions = {
  numberOfResolutions?: number;
  initialTransformParameterObject?: JsonCompatible;
  webWorker?: Worker;
  exclusionRect?: NormalizedRect;
  signal?: AbortSignal;
};

let cachedWorkerPromise: Promise<Worker> | null = null;
let cachedWorkerInstance: Worker | null = null;
const cachedParameterMaps = new Map<string, JsonCompatible>();

function terminateWorker(worker: Worker): void {
  try {
    worker.terminate();
  } catch {
    // ignore
  }
}

function invalidateCachedWorker(candidate: { promise?: Promise<Worker>; worker?: Worker }): void {
  const matchesPromise = candidate.promise != null && cachedWorkerPromise === candidate.promise;
  const matchesWorker = candidate.worker != null && cachedWorkerInstance === candidate.worker;
  if (!matchesPromise && !matchesWorker) return;
  cachedWorkerPromise = null;
  cachedWorkerInstance = null;
}

function getElastixWorker(): Promise<Worker> {
  if (!cachedWorkerPromise) {
    const workerPromise = (async () => {
      const m = await importElastix();

      // Worker initialization can involve loading the worker script + setting up Comlink.
      const initialization = m.getDefaultWebWorker();
      try {
        return await withTimeout(initialization, 30_000, 'Elastix worker initialization');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('timed out')) {
          // The timeout cannot cancel the worker factory. If it eventually succeeds, terminate
          // the now-unreachable worker instead of leaking it alongside the retry.
          void initialization.then(terminateWorker, () => undefined);
        }
        throw error;
      }
    })();
    cachedWorkerPromise = workerPromise;
    cachedWorkerInstance = null;
    void workerPromise.then(
      (worker) => {
        if (cachedWorkerPromise === workerPromise) cachedWorkerInstance = worker;
      },
      () => {
        // An older failure must not erase a newer retry installed after cancellation.
        invalidateCachedWorker({ promise: workerPromise });
      },
    );
  }

  return cachedWorkerPromise;
}

async function getParameterMap(
  kind: ElastixTransformKind,
  webWorker: Worker,
  numberOfResolutions: number,
): Promise<JsonCompatible> {
  const cacheKey = `${kind}:${numberOfResolutions}`;
  const cached = cachedParameterMaps.get(cacheKey);
  if (cached) return cached;

  const m = await importElastix();
  const { parameterMap } = await withTimeout(
    m.defaultParameterMap(kind, {
      numberOfResolutions,
      webWorker,
    }),
    60_000,
    `Elastix defaultParameterMap(${kind})`,
  );

  cachedParameterMaps.set(cacheKey, parameterMap);
  return parameterMap;
}

async function register2DWithElastix(
  kind: ElastixTransformKind,
  fixedPixels: Float32Array,
  movingPixels: Float32Array,
  size: number,
  opts?: Register2DOptions,
): Promise<Elastix2DRegistrationResult> {
  assertSquareSize(fixedPixels, size, 'fixedPixels');
  assertSquareSize(movingPixels, size, 'movingPixels');

  const numberOfResolutions = opts?.numberOfResolutions ?? 3;

  let webWorker: Worker;
  if (opts?.webWorker) {
    webWorker = opts.webWorker;
  } else {
    const workerPromise = getElastixWorker();
    webWorker = await withAbort(
      workerPromise,
      opts?.signal,
      () => {
        invalidateCachedWorker({ promise: workerPromise });
        void workerPromise.then(terminateWorker).catch(() => undefined);
      },
      'Elastix worker initialization',
    );
  }
  let activeWebWorker = webWorker;
  const ownedWorkers = new Set<Worker>([webWorker]);
  const terminatedWorkers = new Set<Worker>();
  let workerInvalidationRequested = false;
  const abortActiveWorker = () => {
    workerInvalidationRequested = true;
    for (const worker of ownedWorkers) {
      if (!terminatedWorkers.has(worker)) {
        terminatedWorkers.add(worker);
        terminateWorker(worker);
      }
      invalidateCachedWorker({ worker });
    }
  };

  try {
    const debug = isDebugAlignmentEnabled();

    const exclusion = opts?.exclusionRect ? inpaintExclusionRectSquare(fixedPixels, size, opts.exclusionRect, 4) : null;

    const fixedPixelsForReg = exclusion ? exclusion.pixels : fixedPixels;

    const movingPixelsForReg = opts?.exclusionRect
      ? inpaintExclusionRectSquare(movingPixels, size, opts.exclusionRect, 4).pixels
      : movingPixels;

    if (debug && opts?.exclusionRect) {
      console.info('[alignment] Elastix exclusion rect (preprocess)', {
        size,
        exclusionRect: opts.exclusionRect,
        excludedFrac: exclusion ? Number(exclusion.excludedFrac.toFixed(4)) : null,
        mode: 'feathered-mean-fill',
      });
    }

    const fixed = makeItkFloat32ScalarImage(fixedPixelsForReg, size, 'fixed');
    const moving = makeItkFloat32ScalarImage(movingPixelsForReg, size, 'moving');

    const parameterMap = await withAbort(
      getParameterMap(kind, webWorker, numberOfResolutions),
      opts?.signal,
      abortActiveWorker,
      'Elastix registration',
    );

    // Elastix expects a *parameter object* as an array of parameter maps.
    const parameterObject: JsonCompatible = [parameterMap];

    // We run the pipeline directly (instead of calling the generated `elastix()` wrapper)
    // so we can capture stdout/stderr and optionally parse Elastix' own metric trace.

    const pipelinePromise = (async () => {
      const desiredOutputs = [
        { type: InterfaceTypes.Image },
        { type: InterfaceTypes.TransformList },
        { type: InterfaceTypes.JsonCompatible },
      ];

      type ElastixPipelineInput =
        | { type: typeof InterfaceTypes.JsonCompatible; data: JsonCompatible }
        | { type: typeof InterfaceTypes.Image; data: Image };

      const pipelineBaseUrl = getAppPipelinesBaseUrl();

      const inputs: ElastixPipelineInput[] = [{ type: InterfaceTypes.JsonCompatible, data: parameterObject }];
      const args: string[] = [];

      // Inputs
      const parameterObjectName = '0';
      args.push(parameterObjectName);

      // Outputs
      args.push('0'); // result
      args.push('1'); // transform
      args.push('2'); // transformParameterObject

      // Options
      args.push('--memory-io');

      // fixed
      {
        const inputCountString = inputs.length.toString();
        inputs.push({ type: InterfaceTypes.Image, data: fixed });
        args.push('--fixed', inputCountString);
      }

      // moving
      {
        const inputCountString = inputs.length.toString();
        inputs.push({ type: InterfaceTypes.Image, data: moving });
        args.push('--moving', inputCountString);
      }

      if (opts?.initialTransformParameterObject) {
        const inputCountString = inputs.length.toString();
        inputs.push({ type: InterfaceTypes.JsonCompatible, data: opts.initialTransformParameterObject });
        args.push('--initial-transform-parameter-object', inputCountString);
      }

      const {
        webWorker: usedWebWorker,
        returnValue,
        stdout,
        stderr,
        outputs,
      } = await runPipeline('elastix', args, desiredOutputs, inputs, {
        pipelineBaseUrl,
        webWorker: activeWebWorker,
      });
      activeWebWorker = (usedWebWorker ?? activeWebWorker) as Worker;
      ownedWorkers.add(activeWebWorker);
      if (workerInvalidationRequested) abortActiveWorker();

      if (returnValue !== 0) {
        const msg = stderr || stdout || `Elastix failed with returnValue=${returnValue}`;
        throw new Error(msg);
      }

      return {
        webWorker: activeWebWorker,
        result: outputs[0]?.data as Image,
        transformParameterObject: outputs[2]?.data as JsonCompatible,
        stdout,
        stderr,
      };
    })();
    const result = await withTimeout(
      withAbort(pipelinePromise, opts?.signal, abortActiveWorker, 'Elastix registration'),
      240_000,
      'Elastix registration',
    );

    const resampled = result.result.data;
    if (!resampled) {
      throw new Error('Elastix returned no resampled image data');
    }

    // The resampled image should match the fixed image size. We keep it as Float32Array.
    const resampledMovingPixels =
      resampled instanceof Float32Array ? resampled : Float32Array.from(resampled as unknown as ArrayLike<number>);
    const expectedPixelCount = size * size;
    if (resampledMovingPixels.length !== expectedPixelCount) {
      throw new Error(
        `Elastix returned malformed resampled image data: expected ${expectedPixelCount} pixels for ${size}x${size}, got ${resampledMovingPixels.length}`,
      );
    }

    // Elastix reports its transform parameters in a parameter-map JSON representation.
    // When an initial transform is provided, the resulting object can include a *chain* of
    // transforms. We must compose the chain to recover the effective mapping.
    const standardChain = parseTransformParameterObjectToStandardAffines(result.transformParameterObject);
    const candidatesStd = buildElastixTransformCandidatesStd(standardChain);

    // We intentionally avoid hard-coding whether the parameter object represents fixed->moving
    // or moving->fixed. Instead, we compare candidates against elastix's returned resample.
    //
    // This prevents subtle convention mismatches (or chain ordering issues) from silently
    // producing incorrect on-screen geometry despite the registration output looking plausible.
    const { best, candidates } = chooseBestElastixTransformCandidateAboutOrigin({
      movingPixels: movingPixelsForReg,
      resampledMovingPixels,
      size,
      candidatesStd,
    });

    if (debug) {
      console.info('[alignment] Elastix transform sanity check', {
        size,
        chosen: best.label,
        mad: Number(best.mad.toFixed(6)),
        maxAbs: Number(best.maxAbs.toFixed(6)),
        // Log the runner-up too; if these are close, the convention is ambiguous (usually near-identity).
        runnerUp: candidates[1]
          ? {
              label: candidates[1].label,
              mad: Number(candidates[1].mad.toFixed(6)),
              maxAbs: Number(candidates[1].maxAbs.toFixed(6)),
            }
          : null,
      });
    }

    const m2fAboutOrigin = best.aboutOrigin;

    // Quality metrics (computed in fixed space against elastix' resampled moving).
    const miResult = computeMutualInformation(
      fixedPixelsForReg,
      resampledMovingPixels,
      opts?.exclusionRect
        ? {
            bins: 64,
            exclusionRect: opts.exclusionRect,
            imageWidth: size,
            imageHeight: size,
          }
        : 64,
    );
    const metricFromLogs = tryParseElastixFinalMetricFromLogs(result.stdout, result.stderr);

    const elastixLogTail = debug
      ? {
          stdout: tailString(result.stdout, 4000),
          stderr: tailString(result.stderr, 4000),
        }
      : undefined;

    if (debug && (result.stdout || result.stderr)) {
      console.info('[alignment] Elastix pipeline logs (tail)', {
        stdoutChars: result.stdout.length,
        stderrChars: result.stderr.length,
        elastixFinalMetric: metricFromLogs.finalMetric,
        metricSamples: metricFromLogs.samples,
        // MI/NMI are computed on (fixedPixels, resampledMovingPixels).
        mi: Number(miResult.mi.toFixed(6)),
        nmi: Number(miResult.nmi.toFixed(6)),
        stdoutTail: elastixLogTail?.stdout,
        stderrTail: elastixLogTail?.stderr,
      });
    }

    return {
      movingToFixed: best.std,
      A: m2fAboutOrigin.A,
      translatePx: m2fAboutOrigin.t,
      resampledMovingPixels,
      transformParameterObject: result.transformParameterObject,
      quality: {
        mi: miResult.mi,
        nmi: miResult.nmi,
        bins: miResult.bins,
        elastixFinalMetric: metricFromLogs.finalMetric,
        elastixMetricSamples: metricFromLogs.samples,
      },
      elastixLogTail,
      webWorker: result.webWorker,
    };
  } catch (error) {
    // A failed registration leaves worker state untrustworthy regardless of whether the failure
    // came from parameter-map loading, the pipeline, transform decoding, or result construction.
    abortActiveWorker();
    throw error;
  }
}

/** Run a rigid 2D registration and return a canonical moving -> fixed transform. */
export async function registerRigid2DWithElastix(
  fixedPixels: Float32Array,
  movingPixels: Float32Array,
  size: number,
  opts?: Register2DOptions,
): Promise<Elastix2DRegistrationResult> {
  return register2DWithElastix('rigid', fixedPixels, movingPixels, size, {
    ...opts,
    numberOfResolutions: opts?.numberOfResolutions ?? 3,
  });
}

/** Run an affine 2D registration and return a canonical moving -> fixed transform. */
export async function registerAffine2DWithElastix(
  fixedPixels: Float32Array,
  movingPixels: Float32Array,
  size: number,
  opts?: Register2DOptions,
): Promise<ElastixAffine2DRegistrationResult> {
  return register2DWithElastix('affine', fixedPixels, movingPixels, size, opts);
}
