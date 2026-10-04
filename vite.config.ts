import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { PWA_MANIFEST, PWA_WORKBOX } from './apps/web/src/pwa.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'generateSW',
      // Prompt, never auto-update: the in-app notice reloads only when no
      // unsent local entries exist, and never during a send on its own.
      registerType: 'prompt',
      injectRegister: 'auto',
      manifest: PWA_MANIFEST,
      workbox: PWA_WORKBOX,
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'apps/web/src'),
    },
  },
  root: resolve(__dirname, 'apps/web'),
  envDir: resolve(__dirname),
  publicDir: resolve(__dirname, 'apps/web/public'),
  build: {
    outDir: resolve(__dirname, 'apps/web/dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
