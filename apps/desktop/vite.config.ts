import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Tauri serves the built assets from ../dist and expects a fixed port in dev.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    // Component tests are `.tsx`; the render harness lives beside them.
    include: ['src/tests/**/*.test.{ts,tsx}'],
  },
});
