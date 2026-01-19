import '@testing-library/jest-dom';
import 'fake-indexeddb/auto';

// Stub ResizeObserver for components using it.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// @ts-expect-error - global assignment for tests
global.ResizeObserver = ResizeObserverStub;

// Stub matchMedia used by some libraries
if (!window.matchMedia) {
  window.matchMedia = () => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

// Stub createObjectURL/revokeObjectURL
if (!window.URL.createObjectURL) {
  window.URL.createObjectURL = () => 'blob:mock';
}
if (!window.URL.revokeObjectURL) {
  window.URL.revokeObjectURL = () => {};
}

function readAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

// Some test environments don't implement File/Blob.arrayBuffer yet.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function () {
    return readAsArrayBuffer(this);
  };
}

if (!Blob.prototype.stream) {
  Blob.prototype.stream = function () {
    const arrayBuffer = this.arrayBuffer.bind(this);
    return new ReadableStream({
      async start(controller) {
        const buffer = await arrayBuffer();
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    });
  };
}

if (!File.prototype.arrayBuffer) {
  File.prototype.arrayBuffer = function () {
    return readAsArrayBuffer(this);
  };
}

// jsdom shims to avoid noisy warnings in tests.
HTMLElement.prototype.blur = () => {};
if (typeof Window !== 'undefined') {
  Window.prototype.blur = () => {};
}
Object.defineProperty(window, 'blur', {
  value: () => {},
  configurable: true,
});
HTMLAnchorElement.prototype.click = () => {};
