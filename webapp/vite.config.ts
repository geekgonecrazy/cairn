import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// SPA base path is /__hub/ so the same build can be hosted by the Wails3 native
// app (which claims /wails/) and by cairnd. The Connect API and SSE live at the
// server root (/cairn.v1.CairnService/*, /v1/*) — proxied to cairnd in dev.
const API_TARGET = process.env.CAIRND_URL || 'http://127.0.0.1:8099'

export default defineConfig({
  base: '/__hub/',
  plugins: [svelte()],
  server: {
    // Bind explicitly rather than relying on `localhost` resolving.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/cairn.v1.CairnService': { target: API_TARGET, changeOrigin: true },
      '/v1': { target: API_TARGET, changeOrigin: true },
    },
  },
})
