import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

vi.mock('../src/components/ComparisonMatrix', () => ({
  ComparisonMatrix: () => <div data-testid="comparison-matrix" />,
}));

describe('App', () => {
  it('renders ComparisonMatrix', async () => {
    const { default: App } = await import('../src/App');
    render(<App />);
    expect(screen.getByTestId('comparison-matrix')).toBeInTheDocument();
  });
});

describe('main', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.resetModules();
  });

  it('initializes cornerstone and storage persistence', async () => {
    vi.doMock('../src/utils/cornerstoneInit', () => ({
      initCornerstone: vi.fn(),
    }));
    vi.doMock('../src/db/db', () => ({
      initStoragePersistence: vi.fn(),
    }));

    await act(async () => {
      await import('../src/main');
    });
    const { initCornerstone } = await import('../src/utils/cornerstoneInit');
    const { initStoragePersistence } = await import('../src/db/db');

    expect(initCornerstone).toHaveBeenCalled();
    expect(initStoragePersistence).toHaveBeenCalled();
  });
});
