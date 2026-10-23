import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Serves api/embed.ts (a Vercel Function in production) from the dev
// server, with the model weights the embed script already downloaded.
function embedApi(): Plugin {
  return {
    name: 'embed-api',
    configureServer(server) {
      process.env.EMBED_CACHE_DIR ??= path.resolve('media/models');
      server.middlewares.use('/api/embed', async (req, res) => {
        try {
          const mod = (await server.ssrLoadModule('/api/embed.ts')) as typeof import('./api/embed.ts');
          const response = await mod.GET(new Request(new URL(req.originalUrl ?? '/', 'http://localhost')));
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), embedApi()],
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    // public/media is generated media (hundreds of MB) served alongside the
    // app in development; builds don't copy it.
    copyPublicDir: false,
  },
});
