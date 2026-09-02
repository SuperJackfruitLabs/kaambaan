import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    // Proxy API + live WebSocket to the Worker dev server (`wrangler dev`, default :8787).
    proxy: {
      '/v1': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
      '/auth': { target: 'http://localhost:8787', changeOrigin: true },
      // The hub token handoff (apps/api/src/auth/hub-oauth.ts). Same reason as /auth: these are
      // Worker routes, and the dev server would otherwise answer them with the SPA.
      '/hub': { target: 'http://localhost:8787', changeOrigin: true },
      '/mcp': { target: 'http://localhost:8787', changeOrigin: true },
      '/health': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
