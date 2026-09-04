import { runSvrSliceGpuProbe } from '../svrNativeCompositing.gpu';
import { cancelFinalScoring, measureFinalScoring, measureCoarseRegistration } from './alignmentProbe';
import { measureDerivedStorage } from './storageProbe';
import { measureInteractiveInference, measureRetainedInteractiveInference } from './inferenceProbe';
import { measureCustomModel } from './customModelProbe';

export const probes = {
  gpu: runSvrSliceGpuProbe,
  measureFinalScoring,
  measureCoarseRegistration,
  cancelFinalScoring,
  measureDerivedStorage,
  measureInteractiveInference,
  measureRetainedInteractiveInference,
  measureCustomModel,
};
declare global {
  interface Window {
    miraProbes: typeof probes;
  }
}
window.miraProbes = probes;
