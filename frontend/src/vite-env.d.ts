/// <reference types="vite/client" />

type ViteEnvString = string | undefined;

declare interface ImportMetaEnv {
  // Prefer these if you have them; they follow Vite conventions.
  readonly VITE_GOOGLE_API_KEY: ViteEnvString;
  readonly VITE_GEMINI_API_KEY: ViteEnvString;

  // Also supported via vite.config.ts envPrefix (useful if you already export these in ~/.zshrc).
  readonly GOOGLE_API_KEY: ViteEnvString;
  readonly GEMINI_API_KEY: ViteEnvString;

  readonly VITE_GEMINI_ANALYSIS_MODEL: ViteEnvString;
  readonly VITE_NANO_BANANA_PRO_MODEL: ViteEnvString;
}

declare interface ImportMeta {
  readonly env: ImportMetaEnv;
}
