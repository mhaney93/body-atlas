import { defineConfig } from 'vite';

export default defineConfig({
  // Served from the domain root on Vercel.
  base: '/',
  build: {
    // three.js alone is ~600 kB minified; the app is a single page, so one chunk is fine.
    chunkSizeWarningLimit: 800,
  },
});
