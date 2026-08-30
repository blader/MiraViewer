import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitInteractiveSelection,
  estimateInteractiveSelectionMemory,
  interactiveSelectionBudgetBytes,
  type InteractiveSelectionAdmission,
} from '../src/utils/segmentation/interactiveAdmission';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';

const MIB = 1024 * 1024;
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
  ...changes,
});

afterEach(() => vi.unstubAllGlobals());

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

  it('grows with every retained owner, actual conditioning plane and literal mark', () => {
    const input = request();
    const baseline = estimateInteractiveSelectionMemory(input);
    for (const delta of [
      { retainedBytes: input.retainedBytes + MIB },
      { conditioningFrames: 5 },
      { literalMarkCount: 1000 },
    ])
      expect(estimateInteractiveSelectionMemory(request(delta)).trackingPeakBytes).toBeGreaterThan(
        baseline.trackingPeakBytes,
      );
    expect(
      estimateInteractiveSelectionMemory(request({ conditioningFrames: 5 })).temporalAttentionBytes,
    ).toBeGreaterThan(baseline.temporalAttentionBytes);
    expect(
      estimateInteractiveSelectionMemory(request({ literalMarkCount: 1000 })).promptAttentionBytes,
    ).toBeGreaterThan(baseline.promptAttentionBytes);
  });

  it.each([
    { retainedBytes: NaN },
    { retainedBytes: -1 },
    { sourceLoadPeakBytes: 0 },
    { contextBytes: 123 },
    { editingVoxels: 0 },
    { width: 1.5 },
    { height: Infinity },
    { frameCount: 0 },
    { conditioningFrames: 0 },
    { conditioningFrames: 222 },
    { literalMarkCount: 0 },
    { literalMarkCount: 1, conditioningFrames: 2 },
    { literalMarkCount: Number.MAX_SAFE_INTEGER },
    { editingVoxels: Number.MAX_SAFE_INTEGER },
    { sourceLoadPeakBytes: Number.MAX_SAFE_INTEGER },
    { width: Number.MAX_SAFE_INTEGER, height: 2 },
  ])('rejects invalid or overflowing ownership without allocating source/model arrays: %j', (changes) => {
    expect(() => estimateInteractiveSelectionMemory(request(changes))).toThrow();
  });

  it('chooses only the faithful WASM path, even when a GPU is available', async () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { deviceMemory: 32, gpu: { requestAdapter } });
    vi.stubGlobal('Worker', class {});
    expect(await admitInteractiveSelection(request())).toBe('wasm');
    expect(requestAdapter).not.toHaveBeenCalled();
  });

  it('fails before inference with an actionable estimate on a constrained browser', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 4 });
    vi.stubGlobal('Worker', class {});
    await expect(admitInteractiveSelection(request())).rejects.toThrow(/estimated.*allowance.*unchanged/);
  });

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
