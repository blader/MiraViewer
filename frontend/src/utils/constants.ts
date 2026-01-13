import type { PanelSettings } from '../types/api';

export const DEFAULT_PANEL_SETTINGS: PanelSettings = {
  offset: 0,
  zoom: 1,
  rotation: 0,
  brightness: 100,
  contrast: 100,
  panX: 0,
  panY: 0,
  progress: 0,
};

export const CONTROL_LIMITS = {
  ZOOM: { MIN: 0.1, MAX: 10, STEP: 0.01 },
  ROTATION: { MIN: -180, MAX: 180, STEP: 0.25 },
  BRIGHTNESS: { MIN: 0, MAX: 200, STEP: 1, DEFAULT: 100 },
  CONTRAST: { MIN: 0, MAX: 200, STEP: 1, DEFAULT: 100 },
  SLICE_NAV: { MAX_RANGE: 1000 }, // For the bottom slider
} as const;

export const OVERLAY = {
  PLAY_SPEEDS: [
    { label: '0.5x', value: 2000 },
    { label: '1x', value: 1000 },
    { label: '2x', value: 500 },
    { label: '4x', value: 250 },
  ],
  DEFAULT_SPEED: 1000,
} as const;
