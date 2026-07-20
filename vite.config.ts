import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const basePath = mode === 'addon' ? './' : '/3Dash_webapp/';

  return {
  base: basePath,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Use the existing manifest.json in public/
      manifest: false,
      workbox: {
        // Distinct prefix on every cache this app's SW creates, so a stale-SW
        // cleanup (main.tsx, HA-hosted mode) can safely identify and remove
        // only 3Dash's own caches — this app is often embedded in an iframe
        // on the same origin as Home Assistant's own frontend, which has its
        // own service worker and caches that must never be touched.
        cacheId: '3dash',
        // Precache all built assets (JS, CSS, HTML)
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // Babylon.js bundle is ~7MB — allow precaching since this is a local app
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        // Runtime caching for heavy assets and API calls
        runtimeCaching: [
          {
            // Cache images/icons
            urlPattern: /\.(?:png|jpg|jpeg|webp|ico)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        navigateFallback: `${basePath}index.html`,
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Note: do NOT split @babylonjs/core into multiple chunks — its modules
        // are circularly interdependent and cross-chunk cycles crash at load
        // ("Cannot access X before initialization"). Large-file caching is
        // instead handled by serving precompressed .gz siblings (HA's aiohttp
        // picks them up), which keeps the wire size WebView-cacheable.
        manualChunks: {
          'vendor-babylon': [
            '@babylonjs/core',
            '@babylonjs/loaders',
            '@babylonjs/materials',
          ],
          'vendor-react': [
            'react',
            'react-dom',
            'react-router-dom',
          ],
        },
      },
    },
  },
  server: {
    host: true,
  },
};
});
