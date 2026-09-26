import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

/**
 * LAN Save Relay — dev-only plugin
 *
 * Adds a lightweight REST endpoint at /api/lan-save for transferring
 * save data between devices on the same network.
 *
 * PUT /api/lan-save  — upload save JSON (body = raw JSON)
 * GET /api/lan-save  — download the latest uploaded save
 *
 * Only active during `npm run dev`. Has zero effect on production build.
 */
function lanSaveRelay(): Plugin {
  let saved: { data: string; updatedAt: string } | null = null;

  return {
    name: 'lan-save-relay',
    configureServer(server) {
      server.middlewares.use('/api/lan-save', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.method === 'PUT') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            saved = { data: body, updatedAt: new Date().toISOString() };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, size: body.length, updatedAt: saved.updatedAt }));
          });
          return;
        }

        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          if (saved) {
            res.end(saved.data);
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'no save data' }));
          }
          return;
        }

        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'method not allowed' }));
      });
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [vue(), lanSaveRelay()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          cytoscape: ['cytoscape'],
        },
      },
    },
  },
});
