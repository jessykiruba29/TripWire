interface ImportMetaEnv {
  /** Base URL of the Tripwire backend. Default: http://localhost:8787 */
  readonly VITE_API_BASE_URL?: string;
  /** 'live' | 'mock' | 'auto' (default 'auto'). */
  readonly VITE_API_MODE?: 'live' | 'mock' | 'auto';
  /** Latency injected by the in-browser mock engine, for demoing loading states. */
  readonly VITE_MOCK_LATENCY_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
