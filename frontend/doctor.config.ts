import { defineConfig } from 'react-doctor/api';

export default defineConfig({
  ignore: {
    files: ['dist/**', 'release/**', 'tmp/**'],
    overrides: [
      {
        files: [
          // Yielding between sequential CPU slices is what keeps reconstruction responsive
          // and cancellable. Parallelizing these shared-buffer loops defeats both guarantees.
          'src/utils/svr/glRaymarch.ts',
          'src/utils/svr/reconstructionCore.ts',
          'src/utils/svr/renderLod.ts',
          // Patient-space annotation transfer yields between bounded chunks;
          // parallelizing it would duplicate buffers and break cancellation.
          'src/utils/svr/refineRegion.ts',
          'src/utils/svr/rigidRegistration.ts',
          'src/utils/svr/svrComputeCore.ts',
          // DICOM decoding, ZIP integrity checks, restore transactions, and model writes
          // are deliberately ordered and bounded to preserve ownership, rollback, and RAM.
          'src/components/UploadModal.tsx',
          'src/services/dicomIngestion.ts',
          'src/services/exportBackup.ts',
          'src/utils/segmentation/onnx/modelCache.ts',
          'src/utils/svr/longitudinalFrames.ts',
          'src/utils/svr/reconstructVolume.ts',
          // Registration hypotheses share one rendering/scoring worker, cancellation
          // signal, and optimization budget; Promise.all would race those authorities.
          'src/hooks/useAutoAlign.ts',
          'src/utils/svr/longitudinalRegistration.ts',
        ],
        rules: ['react-doctor/async-await-in-loop'],
      },
      {
        // The GPU diagnostic canvas intentionally owns keyboard navigation as an
        // accessible application; role="application" is covered by viewer regressions.
        files: ['src/components/SvrVolume3DViewer.tsx', 'src/components/SvrSegmentationEditor.tsx'],
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
