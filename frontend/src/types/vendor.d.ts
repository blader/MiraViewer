// These dependencies ship without TypeScript declaration files.
// We treat them as `any` to keep the app buildable under strict TS settings.
//
// If we later adopt typed wrappers or community typings, we can replace these.

declare module 'cornerstone-core';
declare module 'cornerstone-wado-image-loader';
declare module 'cornerstone-tools';
declare module 'cornerstone-math';
declare module 'hammerjs';
