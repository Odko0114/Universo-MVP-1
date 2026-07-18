import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built output is served by the Express app at /join (see server.js), not by
// Vite's own server — `base` must match that mount path so built asset URLs
// resolve correctly.
export default defineConfig({
  plugins: [react()],
  base: '/join/',
  build: {
    outDir: '../public/join',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
