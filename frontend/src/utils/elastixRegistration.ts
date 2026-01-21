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
import type { Mat2, Vec2 } from './affine2d';
import { computeMutualInformation } from './mutualInformation';
import {
  buildElastixTransformCandidatesStd,
  chooseBestElastixTransformCandidateAboutOrigin,
  parseTransformParameterObjectToStandardAffines,
} from './elastixTransform';

const DEBUG_ALIGNMENT_STORAGE_KEY = 'miraviewer:debug-alignment';

function isDebugAlignmentEnabled(): boolean {
  return typeof window !== 'undefined' && window.localStorage.getItem(DEBUG_ALIGNMENT_STORAGE_KEY) === '1';
}

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
      }
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

export type ElastixAffine2DRegistrationResult = {
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

let cachedWorkerPromise: Promise<Worker> | null = null;
const cachedAffineParameterMapByResolutions = new Map<number, JsonCompatible>();

async function getElastixWorker(): Promise<Worker> {
  if (!cachedWorkerPromise) {
    cachedWorkerPromise = (async () => {
      const m = await importElastix();

      // Worker initialization can involve loading the worker script + setting up Comlink.
      return await withTimeout(m.getDefaultWebWorker(), 30_000, 'Elastix worker initialization');
    })();
  }

  try {
    return await cachedWorkerPromise;
  } catch (err) {
    // If initialization failed (or timed out), allow subsequent retries.
    cachedWorkerPromise = null;
    throw err;
  }
}

async function getAffineParameterMap(webWorker: Worker, numberOfResolutions: number): Promise<JsonCompatible> {
  const cached = cachedAffineParameterMapByResolutions.get(numberOfResolutions);
  if (cached) return cached;

  const m = await importElastix();
  const { parameterMap } = await withTimeout(
    m.defaultParameterMap('affine', {
      numberOfResolutions,
      webWorker,
    }),
    60_000,
    'Elastix defaultParameterMap(affine)'
  );

  cachedAffineParameterMapByResolutions.set(numberOfResolutions, parameterMap);
  return parameterMap;
}

/**
 * Run an elastix affine registration on two square grayscale buffers.
 *
 * Returns a *moving->fixed* transform ready to be composed into viewer settings.
 */
export async function registerAffine2DWithElastix(
  fixedPixels: Float32Array,
  movingPixels: Float32Array,
  size: number,
  opts?: {
    numberOfResolutions?: number;
    initialTransformParameterObject?: JsonCompatible;
    webWorker?: Worker;
  }
): Promise<ElastixAffine2DRegistrationResult> {
  assertSquareSize(fixedPixels, size, 'fixedPixels');
  assertSquareSize(movingPixels, size, 'movingPixels');

  const numberOfResolutions = opts?.numberOfResolutions ?? 3;

  const webWorker = opts?.webWorker ?? (await getElastixWorker());

  const fixed = makeItkFloat32ScalarImage(fixedPixels, size, 'fixed');
  const moving = makeItkFloat32ScalarImage(movingPixels, size, 'moving');

  const affineParameterMap = await getAffineParameterMap(webWorker, numberOfResolutions);

  // Elastix expects a *parameter object* as an array of parameter maps.
  const parameterObject: JsonCompatible = [affineParameterMap] as unknown as JsonCompatible;

  // We run the pipeline directly (instead of calling the generated `elastix()` wrapper)
  // so we can capture stdout/stderr and optionally parse Elastix' own metric trace.
  const debug = isDebugAlignmentEnabled();

  let result: {
    webWorker: Worker;
    result: Image;
    transformParameterObject: JsonCompatible;
    stdout: string;
    stderr: string;
  };

  try {
    result = await withTimeout(
      (async () => {
        const desiredOutputs = [
          { type: InterfaceTypes.Image },
          { type: InterfaceTypes.TransformList },
          { type: InterfaceTypes.JsonCompatible },
        ];

        type ElastixPipelineInput =
          | { type: typeof InterfaceTypes.JsonCompatible; data: JsonCompatible }
          | { type: typeof InterfaceTypes.Image; data: Image };

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

        const pipelineBaseUrl = getAppPipelinesBaseUrl();

        const { webWorker: usedWebWorker, returnValue, stdout, stderr, outputs } = await runPipeline(
          'elastix',
          args,
          desiredOutputs,
          inputs,
          {
            pipelineBaseUrl,
            webWorker,
          }
        );

        if (returnValue !== 0) {
          const msg = stderr || stdout || `Elastix failed with returnValue=${returnValue}`;
          throw new Error(msg);
        }

        return {
          webWorker: (usedWebWorker ?? webWorker) as Worker,
          result: outputs[0]?.data as Image,
          transformParameterObject: outputs[2]?.data as JsonCompatible,
          stdout,
          stderr,
        };
      })(),
      240_000,
      'Elastix registration'
    );
  } catch (err) {
    // A timeout here is almost always an asset-loading issue (pipelines base URL) or a stuck worker.
    // Terminate the worker and drop caches so a retry starts from a clean slate.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('timed out')) {
      try {
        webWorker.terminate();
      } catch {
        // ignore
      }
      cachedWorkerPromise = null;
    }

    throw err;
  }

  const resampled = result.result.data;
  if (!resampled) {
    throw new Error('Elastix returned no resampled image data');
  }

  // The resampled image should match the fixed image size. We keep it as Float32Array.
  const resampledMovingPixels =
    resampled instanceof Float32Array ? resampled : Float32Array.from(resampled as unknown as ArrayLike<number>);

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
    movingPixels,
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
  const miResult = computeMutualInformation(fixedPixels, resampledMovingPixels, 64);
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
}
