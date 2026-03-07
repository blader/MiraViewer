import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

import type { SegmentTumorOptions } from '../src/utils/segmentation/segmentTumor';
import {
  parseTumorHarnessDataset,
  runTumorHarnessDataset,
  summarizeReport,
} from '../src/utils/segmentation/harness/runTumorHarness';

async function loadDatasetJsonText(datasetPath: string): Promise<string> {
  const buf = await readFile(datasetPath);

  if (datasetPath.toLowerCase().endsWith('.zip')) {
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file('dataset.json');
    if (!entry) {
      throw new Error('Zip does not contain dataset.json at root');
    }
    return await entry.async('string');
  }

  return buf.toString('utf8');
}

const DATASET_PATH = process.env.TUMOR_HARNESS_DATASET;

if (!DATASET_PATH) {
  test.skip('tumor harness runner (set TUMOR_HARNESS_DATASET to enable)', () => {});
} else {
  test('tumor harness runner', async () => {
    const jsonText = await loadDatasetJsonText(DATASET_PATH);
    const dataset = parseTumorHarnessDataset(jsonText);

    if (dataset.cases.length === 0) {
      throw new Error('Dataset contains 0 cases');
    }

    const v2Off: SegmentTumorOptions = {
      bgModel: { enabled: false },
      geodesic: { enabled: false },
    };

    const v2Bg: SegmentTumorOptions = {
      bgModel: { enabled: true },
      geodesic: { enabled: false },
    };

    const v2BgGeo: SegmentTumorOptions = {
      bgModel: { enabled: true },
      geodesic: { enabled: true },
    };

    const configs = [
      { name: 'baseline', opts: v2Off },
      { name: 'v2:bg', opts: v2Bg },
      { name: 'v2:bg+geo', opts: v2BgGeo },
    ];

    const report = await runTumorHarnessDataset({ dataset, configs });

    const outPath =
      process.env.TUMOR_HARNESS_OUT ??
      path.resolve(process.cwd(), 'tmp', `tumor-harness-report.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');

    const summary = summarizeReport(report);
    // Keep console output intentionally small.
    console.log('[tumor-harness] cases:', dataset.cases.length);
    console.log('[tumor-harness] scenarios:', dataset.propagationScenarios?.length ?? 0);
    console.log('[tumor-harness] report:', outPath);
    if (summary.bestSegConfigByDice) {
      console.log('[tumor-harness] best dice:', summary.bestSegConfigByDice.name, summary.bestSegConfigByDice.dice.toFixed(4));
    }
    if (summary.bestSegConfigByF2) {
      console.log('[tumor-harness] best f2:', summary.bestSegConfigByF2.name, summary.bestSegConfigByF2.f2.toFixed(4));
    }

    expect(report.version).toBe(1);
  });
}
