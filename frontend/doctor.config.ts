import { defineConfig } from 'react-doctor/api';

export default defineConfig({
  ignore: {
    files: ['dist/**', 'release/**', 'tmp/**'],
    overrides: [
      {
        // Yielding between sequential CPU slices is what keeps reconstruction responsive
        // and cancellable. Parallelizing these shared-buffer loops defeats both guarantees.
        files: [
          'src/utils/svr/glRaymarch.ts',
          'src/utils/svr/reconstructionCore.ts',
          'src/utils/svr/renderLod.ts',
          'src/utils/svr/rigidRegistration.ts',
          'src/utils/svr/svrComputeCore.ts',
        ],
        rules: ['react-doctor/async-await-in-loop'],
      },
      {
        // DICOM decoding, ZIP integrity checks, restore transactions, and model writes
        // are deliberately ordered and bounded to preserve ownership, rollback, and RAM.
        files: [
          'src/components/UploadModal.tsx',
          'src/services/dicomIngestion.ts',
          'src/services/exportBackup.ts',
          'src/utils/segmentation/onnx/modelCache.ts',
          'src/utils/svr/longitudinalFrames.ts',
          'src/utils/svr/reconstructVolume.ts',
        ],
        rules: ['react-doctor/async-await-in-loop'],
      },
      {
        // Registration hypotheses share one rendering/scoring worker, cancellation
        // signal, and optimization budget; Promise.all would race those authorities.
        files: ['src/hooks/useAutoAlign.ts', 'src/utils/svr/longitudinalRegistration.ts'],
        rules: ['react-doctor/async-await-in-loop'],
      },
      {
        // The GPU diagnostic canvas intentionally owns keyboard navigation as an
        // accessible application; role="application" is covered by viewer regressions.
        files: ['src/components/SvrVolume3DViewer.tsx'],
        rules: ['react-doctor/no-interactive-element-to-noninteractive-role'],
      },
      {
        // This setter is already inside finally. Its generation guard is essential so
        // stale patient loads cannot clear a newer request's loading indicator.
        files: ['src/hooks/useComparisonData.ts'],
        rules: ['react-doctor/no-loading-flag-reset-outside-finally'],
      },
      {
        // Alignment results and panel settings have the same ComparisonMatrix owner.
        // Applying verified asynchronous results here preserves the reference frame.
        files: ['src/hooks/useApplyAlignmentResults.ts'],
        rules: ['react-doctor/no-pass-data-to-parent'],
      },
    ],
  },
});
