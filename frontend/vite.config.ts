import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The deterministic mock engine under ../mock-backend is imported by the
// in-browser mock adapter, so it must be readable/aliased from the web root.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@engine': path.resolve(__dirname, '../mock-backend/engine'),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    testTimeout: 20000,
  },
});
