import { createContext, useContext } from 'react';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';

/** Binary MRI buffers are shared imaging state, not recursively inspectable view props. */
export const SvrImagingContext = createContext<{
  volume: SvrVolume | null;
  labels?: SvrLabelVolume | null;
  initialSelection?: SvrLabelVolume;
  busy?: boolean;
  refineRegion?: (labels: SvrLabelVolume) => void;
} | null>(null);

export function useSvrImaging() {
  const imaging = useContext(SvrImagingContext);
  if (!imaging) throw new Error('The SVR viewer requires its imaging workspace.');
  return imaging;
}
