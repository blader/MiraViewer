import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitInteractiveSelection,
  estimateInteractiveSelectionMemory,
  interactiveSelectionBudgetBytes,
  InteractiveSelectionMemoryError,
  type InteractiveSelectionAdmission,
} from '../src/utils/segmentation/interactiveAdmission';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';
import assetManifest from '../src/utils/segmentation/efficientTam/assetManifest.json';

const graphOverride = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));
vi.mock('../src/utils/segmentation/efficientTam/assetManifest.json', async (importOriginal) => {
  const { default: original } = await importOriginal<{ default: typeof assetManifest }>();
  return {
    default: {
      ...original,
      graphs: {
        ...original.graphs,
        get memoryAttention() {
          return graphOverride.value ?? original.graphs.memoryAttention;
        },
      },
    },
  };
});

const MIB = 1024 * 1024;
const queryAttention = assetManifest.graphs.memoryAttention;
const sourceAttention = {
  path: queryAttention.path,
  sha256: queryAttention.queryChunking.sourceSha256,
  bytes: queryAttention.queryChunking.sourceBytes,
};
const request = (changes: Partial<InteractiveSelectionAdmission> = {}): InteractiveSelectionAdmission => ({
  signal: new AbortController().signal,
  retainedBytes: 360 * MIB,
  sourceLoadPeakBytes: 420 * MIB,
  contextBytes: 187 * 187 * 221 * 5,
  editingVoxels: 256 * 256 * 111,
  width: 187,
  height: 187,
  frameCount: 221,
  conditioningFrames: 1,
  literalMarkCount: 103,
  maximumFramePrompts: 32,
  ...changes,
});

afterEach(() => {
  vi.unstubAllGlobals();
  graphOverride.value = undefined;
});

describe('interactive selection admission', () => {
  it('keeps learned-selection estimates separate from the native reconstruction limit', () => {
    expect(SVR_MEMORY_BUDGET_BYTES).toBe(512 * MIB);
    expect(interactiveSelectionBudgetBytes(32)).toBe(3072 * MIB);
    expect(interactiveSelectionBudgetBytes(16)).toBe(3072 * MIB);
    expect(interactiveSelectionBudgetBytes(8)).toBe(2048 * MIB);
    expect(interactiveSelectionBudgetBytes(4)).toBe(1024 * MIB);
    expect(interactiveSelectionBudgetBytes(2)).toBe(512 * MIB);
    for (const value of [undefined, NaN, Infinity, 0, -1])
      expect(interactiveSelectionBudgetBytes(value)).toBe(1536 * MIB);
  });

  it('includes native assembly and crop simultaneously, not twice in the model phase', () => {
    const input = request();
    const plan = estimateInteractiveSelectionMemory(input);
    expect(plan.sourcePeakBytes).toBe(input.sourceLoadPeakBytes + input.contextBytes);
    expect(plan.totalBytes).toBe(Math.max(plan.sourcePeakBytes, plan.trackingPeakBytes, plan.publicationPeakBytes));
    expect(plan.totalBytes).toBeLessThan(interactiveSelectionBudgetBytes(8));
    const loaded = estimateInteractiveSelectionMemory(request({ sourceLoadPeakBytes: 1800 * MIB }));
    expect(loaded.totalBytes).toBe(1800 * MIB + input.contextBytes);
    expect(loaded.trackingPeakBytes).toBe(plan.trackingPeakBytes);
    // Future cache capacity belongs to BOTH absolute load and retained owners.
    const browsing = estimateInteractiveSelectionMemory(
      request({
        sourceLoadPeakBytes: 1800 * MIB + 32 * MIB,
        retainedBytes: input.retainedBytes + 32 * MIB,
      }),
    );
    expect(browsing.totalBytes - loaded.totalBytes).toBe(32 * MIB);
  });

  it('budgets publication before history trimming and includes anisotropic resize scratch', () => {
    const input = request({ editingVoxels: 100_000_000 });
    const plan = estimateInteractiveSelectionMemory(input);
    expect(plan.publicationPeakBytes).toBe(
      input.retainedBytes + (input.contextBytes * 6) / 5 + input.editingVoxels * 18,
    );
    expect(plan.totalBytes).toBe(plan.publicationPeakBytes);
    const tall = estimateInteractiveSelectionMemory(
      request({ width: 1, height: 100_000, frameCount: 1, contextBytes: 500_000, conditioningFrames: 1 }),
    );
    expect(tall.frameScratchBytes).toBeGreaterThan(512 * 100_000);
  });

  it('exposes component sums for each phase without double counting non-overlapping peaks', () => {
    const input = request();
    const plan = estimateInteractiveSelectionMemory(input);
    expect(plan.retainedBytes).toBe(input.retainedBytes);
    expect(plan.sourceLoadPeakBytes).toBe(input.sourceLoadPeakBytes);
    expect(plan.contextBytes).toBe(input.contextBytes);
    expect(plan.contextMaskBytes).toBe(input.width * input.height * input.frameCount);
    expect(plan.runtimeAllowanceBytes).toBe(1024 * MIB);
    expect(plan.retainedStateBytes).toBeGreaterThan(0);
    expect(plan.packedMemoryBytes).toBeGreaterThan(0);
    expect(plan.publicationScratchBytes).toBe(input.editingVoxels * 18);
    expect(plan.sourcePeakBytes).toBe(plan.sourceLoadPeakBytes + plan.contextBytes);
    expect(plan.trackingPeakBytes).toBe(
      plan.retainedBytes +
        plan.contextBytes +
        plan.contextMaskBytes +
        plan.runtimeAllowanceBytes +
        plan.retainedStateBytes +
        plan.packedMemoryBytes +
        plan.temporalAttentionBytes +
        plan.promptAttentionBytes +
        plan.frameScratchBytes,
    );
    expect(plan.publicationPeakBytes).toBe(
      plan.retainedBytes + plan.contextBytes + plan.contextMaskBytes + plan.publicationScratchBytes,
    );
    expect(plan.totalBytes).toBe(Math.max(plan.sourcePeakBytes, plan.trackingPeakBytes, plan.publicationPeakBytes));
    expect(plan.totalBytes).toBeLessThan(plan.sourcePeakBytes + plan.trackingPeakBytes + plan.publicationPeakBytes);
  });

  it('grows with every retained owner and actual conditioning plane', () => {
    const input = request();
    const baseline = estimateInteractiveSelectionMemory(input);
    for (const delta of [{ retainedBytes: input.retainedBytes + MIB }, { conditioningFrames: 5 }])
      expect(estimateInteractiveSelectionMemory(request(delta)).trackingPeakBytes).toBeGreaterThan(
        baseline.trackingPeakBytes,
      );
    expect(
      estimateInteractiveSelectionMemory(request({ conditioningFrames: 5 })).temporalAttentionBytes,
    ).toBeGreaterThan(baseline.temporalAttentionBytes);
  });

  it('charges retained runtime high-water memory once in loading, tracking and warm publication', () => {
    const input = request();
    const cold = estimateInteractiveSelectionMemory(input);
    const retainedRuntimeBytes = cold.runtimeBytes + 64 * MIB;
    const warm = estimateInteractiveSelectionMemory({ ...input, retainedRuntimeBytes, retainRuntimeAfterRun: true });
    expect(warm.sourcePeakBytes - cold.sourcePeakBytes).toBe(retainedRuntimeBytes);
    expect(warm.trackingPeakBytes - cold.trackingPeakBytes).toBe(64 * MIB);
    expect(warm.publicationPeakBytes - cold.publicationPeakBytes).toBe(retainedRuntimeBytes);
    expect(warm.publicationRuntimeBytes).toBe(retainedRuntimeBytes);
    expect(warm.totalBytes).toBe(Math.max(warm.sourcePeakBytes, warm.trackingPeakBytes, warm.publicationPeakBytes));
  });

  it('reclaims retained runtime before publication without discounting the active model phase', () => {
    const input = request({ editingVoxels: 40_000_000 });
    const cold = estimateInteractiveSelectionMemory(input);
    const retainedRuntimeBytes = cold.runtimeBytes;
    const warm = estimateInteractiveSelectionMemory({ ...input, retainedRuntimeBytes, retainRuntimeAfterRun: true });
    const released = estimateInteractiveSelectionMemory({
      ...input,
      retainedRuntimeBytes,
      retainRuntimeAfterRun: false,
    });
    expect(warm.totalBytes).toBeGreaterThan(interactiveSelectionBudgetBytes(8));
    expect(released.totalBytes).toBeLessThan(interactiveSelectionBudgetBytes(8));
    expect(released.sourcePeakBytes).toBe(warm.sourcePeakBytes);
    expect(released.trackingPeakBytes).toBe(warm.trackingPeakBytes);
    expect(released.publicationPeakBytes).toBe(cold.publicationPeakBytes);
    expect(released.publicationRuntimeBytes).toBe(0);
  });

  it('charges additional literal marks only to linear mapping scratch when the busiest frame is unchanged', () => {
    const input = request();
    const baseline = estimateInteractiveSelectionMemory(input);
    const expanded = estimateInteractiveSelectionMemory(request({ literalMarkCount: 1000 }));
    expect(expanded.frameScratchBytes - baseline.frameScratchBytes).toBe((1000 - input.literalMarkCount) * 1024);
    expect(expanded.trackingPeakBytes - baseline.trackingPeakBytes).toBe((1000 - input.literalMarkCount) * 1024);
    for (const field of [
      'promptAttentionBytes',
      'temporalAttentionBytes',
      'retainedStateBytes',
      'packedMemoryBytes',
      'runtimeAllowanceBytes',
      'sourcePeakBytes',
      'publicationPeakBytes',
    ] as const)
      expect(expanded[field]).toBe(baseline[field]);
    // Component medoids may compress many literal marks to one prompt on a marked frame.
    expect(() =>
      estimateInteractiveSelectionMemory(request({ literalMarkCount: 1000, maximumFramePrompts: 1 })),
    ).not.toThrow();
  });

  it('charges decoder attention to the maximum prompts on one frame plus its seven special tokens', () => {
    const baseline = estimateInteractiveSelectionMemory(request());
    const expanded = estimateInteractiveSelectionMemory(request({ maximumFramePrompts: 64 }));
    const attention = (prompts: number) => 2 * 4 * 8 * (2 * (prompts + 7) ** 2 + 5 * (prompts + 7) * 1024);
    expect(baseline.promptAttentionBytes).toBe(attention(32));
    expect(expanded.promptAttentionBytes).toBe(attention(64));
    expect(expanded.trackingPeakBytes - baseline.trackingPeakBytes).toBe(attention(64) - attention(32));
    expect(expanded.frameScratchBytes).toBe(baseline.frameScratchBytes);
    expect(expanded.temporalAttentionBytes).toBe(baseline.temporalAttentionBytes);
  });

  it('admits distributed marks without charging their global count as one quadratic decoder input', async () => {
    const distributed = request({ literalMarkCount: 4000, maximumFramePrompts: 250, conditioningFrames: 16 });
    const plan = estimateInteractiveSelectionMemory(distributed);
    const concentrated = estimateInteractiveSelectionMemory(
      request({ literalMarkCount: 4000, maximumFramePrompts: 4000 }),
    );
    expect(plan.promptAttentionBytes).toBe(2 * 4 * 8 * (2 * 257 ** 2 + 5 * 257 * 1024));
    expect(plan.promptAttentionBytes).toBeLessThan(concentrated.promptAttentionBytes);
    expect(plan.temporalAttentionBytes).toBeGreaterThan(concentrated.temporalAttentionBytes);
    expect(plan.frameScratchBytes).toBe(concentrated.frameScratchBytes);
    expect(plan.totalBytes).toBeLessThan(interactiveSelectionBudgetBytes(32));
    expect(concentrated.totalBytes).toBeGreaterThan(interactiveSelectionBudgetBytes(32));
    vi.stubGlobal('navigator', { deviceMemory: 32 });
    vi.stubGlobal('Worker', class {});
    expect(await admitInteractiveSelection(distributed)).toMatchObject({
      provider: 'wasm',
      estimate: estimateInteractiveSelectionMemory(distributed),
    });
  });

  it.each([140, 512])(
    'keeps all %s conditioning states and full-key owners when only query score rows are blocked',
    async (conditioningFrames) => {
      const input = Object.freeze(
        request({
          frameCount: 527,
          contextBytes: 187 * 187 * 527 * 5,
          conditioningFrames,
          literalMarkCount: conditioningFrames * 32,
        }),
      );
      const memoryTokens = (conditioningFrames + 6) * 1024 + (conditioningFrames + 15) * 4;
      const blocked = estimateInteractiveSelectionMemory(input);
      // Historical formula comparison only; v1 is no longer an admitted execution path.
      const originalTrackingPeak =
        blocked.trackingPeakBytes - blocked.temporalAttentionBytes + 2 * 4 * 4 * 1024 * memoryTokens;
      expect(originalTrackingPeak).toBeGreaterThan(6 * 1024 * MIB);
      expect(blocked.trackingPeakBytes).toBeLessThan(originalTrackingPeak);
      // Combined operational workspace, not a claim that six buffers bound the isolated rotary peak.
      const scoreBlocks = 2 * 4 * 1 * Float32Array.BYTES_PER_ELEMENT * 64 * memoryTokens;
      const fullKeyWorkspace = 6 * 256 * Float32Array.BYTES_PER_ELEMENT * memoryTokens;
      expect(blocked.temporalAttentionBytes).toBe(scoreBlocks + fullKeyWorkspace);
      expect(blocked.temporalAttentionBytes).toBe(8192 * memoryTokens);
      expect(blocked.packedMemoryBytes).toBe(memoryTokens * 64 * 4 * 2);
      expect(blocked.retainedStateBytes).toBe(
        conditioningFrames * (1024 * 64 * 2 + 256 * 4 + (128 * 128 + 187 * 187 + 2) * 4) +
          6 * 1024 * 64 * 2 +
          15 * 256 * 4,
      );
      expect(blocked.frameScratchBytes).toBe(16 * MIB + 187 * 187 * 64 + 512 * 187 + input.literalMarkCount * 1024);
      expect(blocked.runtimeAllowanceBytes).toBe(1024 * MIB);
      expect(blocked.retainedBytes).toBe(input.retainedBytes);
      expect(blocked.sourceLoadPeakBytes).toBe(input.sourceLoadPeakBytes);
      expect(blocked.contextBytes).toBe(input.contextBytes);
      expect(blocked.contextMaskBytes).toBe(input.width * input.height * input.frameCount);
      expect(blocked.publicationScratchBytes).toBe(input.editingVoxels * 18);
      expect(blocked.totalBytes).toBe(
        Math.max(blocked.sourcePeakBytes, blocked.trackingPeakBytes, blocked.publicationPeakBytes),
      );
      vi.stubGlobal('navigator', { deviceMemory: 32 });
      vi.stubGlobal('Worker', class {});
      if (conditioningFrames === 140) {
        expect(blocked.totalBytes).toBeLessThan(interactiveSelectionBudgetBytes(32));
        expect(await admitInteractiveSelection(input)).toMatchObject({
          provider: 'wasm',
          estimate: estimateInteractiveSelectionMemory(input),
        });
      } else {
        expect(blocked.totalBytes).toBeGreaterThan(interactiveSelectionBudgetBytes(32));
        await expect(admitInteractiveSelection(input)).rejects.toMatchObject({
          name: 'InteractiveSelectionMemoryError',
          budgetBytes: 3072 * MIB,
          atAppCap: true,
          counts: { conditioningFrames, literalMarkCount: conditioningFrames * 32, maximumFramePrompts: 32 },
        });
      }
      expect(input).toMatchObject({ conditioningFrames, literalMarkCount: conditioningFrames * 32 });
    },
  );

  it('rejects legacy graphs without required query metadata instead of retaining a fallback estimate', () => {
    graphOverride.value = sourceAttention;
    expect(() => estimateInteractiveSelectionMemory(request())).toThrow(/derived attention graph/);
  });

  it('does not grant query-block credit to the unchanged source graph', () => {
    graphOverride.value = { ...sourceAttention, queryChunking: queryAttention.queryChunking };
    expect(() => estimateInteractiveSelectionMemory(request())).toThrow(/derived attention graph/);
  });

  it.each([
    { sourceSha256: 'unbound' },
    { sourceBytes: 0 },
    { queryChunkRows: 0 },
    { queryChunkRows: 65 },
    { queryChunkRows: 2048 },
    { layers: -1 },
    { heads: NaN },
    { keyValueChannels: Infinity },
    { projectionBufferAllowance: 0 },
  ])('rejects malformed query-block metadata instead of silently discounting attention: %j', (changes) => {
    graphOverride.value = { ...queryAttention, queryChunking: { ...queryAttention.queryChunking, ...changes } };
    expect(() => estimateInteractiveSelectionMemory(request())).toThrow(/derived attention graph/);
  });

  it('accepts the smallest literal count that can cover the busiest frame and every other marked frame', () => {
    expect(() =>
      estimateInteractiveSelectionMemory(
        request({ literalMarkCount: 5, maximumFramePrompts: 3, conditioningFrames: 3 }),
      ),
    ).not.toThrow();
  });

  it.each([
    { retainedBytes: NaN },
    { retainedBytes: -1 },
    { retainedRuntimeBytes: NaN },
    { retainedRuntimeBytes: -1 },
    { retainedRuntimeBytes: Number.MAX_SAFE_INTEGER },
    { sourceLoadPeakBytes: 0 },
    { contextBytes: 123 },
    { editingVoxels: 0 },
    { width: 1.5 },
    { height: Infinity },
    { frameCount: 0 },
    { conditioningFrames: NaN },
    { conditioningFrames: Infinity },
    { conditioningFrames: -1 },
    { conditioningFrames: 1.5 },
    { conditioningFrames: 0 },
    { conditioningFrames: 222 },
    { literalMarkCount: 0 },
    { maximumFramePrompts: undefined },
    { maximumFramePrompts: NaN },
    { maximumFramePrompts: Infinity },
    { maximumFramePrompts: 0 },
    { maximumFramePrompts: -1 },
    { maximumFramePrompts: 1.5 },
    { maximumFramePrompts: 104 },
    { maximumFramePrompts: Number.MAX_SAFE_INTEGER },
    { literalMarkCount: 1, conditioningFrames: 2 },
    { literalMarkCount: 5, maximumFramePrompts: 4, conditioningFrames: 3 },
    { literalMarkCount: Number.MAX_SAFE_INTEGER },
    { editingVoxels: Number.MAX_SAFE_INTEGER },
    { sourceLoadPeakBytes: Number.MAX_SAFE_INTEGER },
    { width: Number.MAX_SAFE_INTEGER, height: 2 },
    {
      width: 1,
      height: 1,
      frameCount: 1_000_000_000_000,
      conditioningFrames: 1_000_000_000_000,
      literalMarkCount: 1_000_000_000_000,
      maximumFramePrompts: 1,
      contextBytes: 5_000_000_000_000,
    },
  ])('rejects invalid or overflowing ownership without allocating source/model arrays: %j', (changes) => {
    expect(() => estimateInteractiveSelectionMemory(request(changes))).toThrow();
  });

  it('chooses only the faithful WASM path, even when a GPU is available', async () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { deviceMemory: 32, gpu: { requestAdapter } });
    vi.stubGlobal('Worker', class {});
    expect(await admitInteractiveSelection(request())).toMatchObject({ provider: 'wasm' });
    expect(requestAdapter).not.toHaveBeenCalled();
  });

  it('fails before inference with a structured estimate, not a claimed measurement or browser hard limit', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 4 });
    vi.stubGlobal('Worker', class {});
    const input = request();
    const error = await admitInteractiveSelection(input).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(InteractiveSelectionMemoryError);
    expect(error).toMatchObject({
      name: 'InteractiveSelectionMemoryError',
      budgetBytes: 1024 * MIB,
      atAppCap: false,
      estimate: estimateInteractiveSelectionMemory(input),
      counts: { conditioningFrames: 1, maximumFramePrompts: 32, literalMarkCount: 103 },
    });
    const admission = error as InteractiveSelectionMemoryError;
    expect(admission.message).toMatch(/estimated.*MiraViewer's safety budget.*unchanged/);
    expect(admission.message).toContain('not measured memory usage or a browser hard limit');
    expect(admission.message).not.toMatch(/fewer editing marks|delete.*marks|use a browser with more memory/i);
    input.literalMarkCount = 104;
    expect(admission.counts.literalMarkCount).toBe(103);
    expect(Object.isFrozen(admission.counts)).toBe(true);
    expect(admission.counts).not.toHaveProperty('signal');
  });

  it.each([16, 32, 128])(
    'identifies the unchanged MiraViewer cap on a %s GiB device without prescribing more RAM or fewer marks',
    async (deviceMemory) => {
      vi.stubGlobal('navigator', { deviceMemory });
      vi.stubGlobal('Worker', class {});
      const error = await admitInteractiveSelection(request({ sourceLoadPeakBytes: 4000 * MIB })).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(InteractiveSelectionMemoryError);
      expect(error).toMatchObject({ budgetBytes: 3072 * MIB, atAppCap: true });
      const admission = error as InteractiveSelectionMemoryError;
      expect(admission.message).toContain("MiraViewer's safety budget is 3072 MiB");
      expect(admission.message).toContain('MiraViewer has reached its application safety cap');
      expect(admission.message).toContain('not measured memory usage or a browser hard limit');
      expect(admission.message).not.toMatch(/use.*more (?:memory|ram)|fewer.*marks|delete.*marks/i);
      expect(admission.message).toContain('Your current selection and marks are unchanged');
    },
  );

  it.each(['Worker', 'WebAssembly'])('reports unsupported %s without invoking another classifier', async (name) => {
    vi.stubGlobal('navigator', { deviceMemory: 32 });
    vi.stubGlobal('Worker', class {});
    vi.stubGlobal(name, undefined);
    await expect(admitInteractiveSelection(request())).rejects.toThrow(/does not support.*unchanged/);
  });

  it('preserves cancellation before reading device capabilities or allocating anything', async () => {
    const abort = new AbortController();
    abort.abort();
    const read = vi.fn(() => {
      throw new Error('Must not inspect canceled work');
    });
    vi.stubGlobal('navigator', {
      get deviceMemory() {
        return read();
      },
    });
    await expect(admitInteractiveSelection(request({ signal: abort.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(read).not.toHaveBeenCalled();
  });
});
