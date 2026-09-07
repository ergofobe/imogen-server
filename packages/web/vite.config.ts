import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['fonts/*.woff2', 'icons/*.svg', 'theme.js'],
      manifest: {
        name: 'imogen',
        short_name: 'imogen',
        description: 'Your photo library, on your own server.',
        start_url: '/',
        display: 'standalone',
        background_color: '#101113',
        theme_color: '#101113',
        icons: [
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
        // Android share sheets can send photos straight into the library.
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: { files: [{ name: 'files', accept: ['image/*', 'video/*'] }] },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,svg}'],
        // The API reference viewer is 3.8 MB and is not part of the app. Precaching it
        // would put a developer tool into every phone that installs the library, and
        // it exceeds the precache size limit anyway.
        globIgnores: ['**/scalar.js'],
        // A self-hosted app is updated by whoever runs the server, and a stale shell
        // hanging around until every tab closes makes an upgrade look like it failed.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/^\/api/, /^\/oauth/, /^\/mcp/, /^\/\.well-known/],
        runtimeCaching: [
          {
            // Thumbnails are immutable — their URL contains the asset id and variant —
            // so caching them is what makes a revisited timeline feel instant.
            urlPattern: /\/api\/v1\/assets\/[^/]+\/(thumbnail|preview)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'imogen-images',
              expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // The SDK's `types`/`default` exports point at a dist/ it never ships from the submodule;
  // only its `bun` condition reaches the sources, which vite compiles as happily as bun runs
  // them. The defaults are spread back in because this list replaces them rather than adding
  // to them, and dropping `browser` would quietly hand some other package its node build.
  resolve: { conditions: ['bun', ...defaultClientConditions] },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/oauth': { target: 'http://localhost:3000', changeOrigin: true },
      '/.well-known': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
