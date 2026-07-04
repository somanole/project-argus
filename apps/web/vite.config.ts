import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const SERVER_TARGET = process.env.ARGUS_SERVER_URL ?? 'http://127.0.0.1:3000';

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  css: {
    preprocessorOptions: {
      // Use Dart Sass's modern compiler API (silences the legacy-js-api warning).
      scss: { api: 'modern-compiler' },
    },
  },
  server: {
    port: 5173,
    // In dev the placeholder calls the Argus server via a relative /api path;
    // proxy it to the Express server so both run on their own ports.
    proxy: {
      '/api': {
        target: SERVER_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Fail the build on a transform/asset error rather than emitting a broken bundle.
    emptyOutDir: true,
  },
});
