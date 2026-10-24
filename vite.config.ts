import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

type Handler = (request: Request) => Promise<Response>;

// Serves the Vercel Functions in api/ from the dev server: api/embed.ts with
// the model weights the embed script already downloaded, api/enrich.ts with
// the keys in .env.local. Each module exports a handler per HTTP method.
function apiRoutes(): Plugin {
  return {
    name: 'api-routes',
    configureServer(server) {
      process.env.EMBED_CACHE_DIR ??= path.resolve('media/models');
      // Functions read their configuration from process.env, as on Vercel.
      for (const [k, v] of Object.entries(loadEnv(server.config.mode, process.cwd(), ''))) process.env[k] ??= v;
      for (const name of ['embed', 'enrich', 'unfurl']) {
        server.middlewares.use(`/api/${name}`, async (req, res) => {
          try {
            const mod = (await server.ssrLoadModule(`/api/${name}.ts`)) as Record<string, Handler | undefined>;
            const handler = mod[req.method ?? 'GET'];
            if (!handler) {
              res.statusCode = 405;
              res.end();
              return;
            }
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
            const response = await handler(
              new Request(new URL(req.originalUrl ?? '/', 'http://localhost'), { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }),
            );
            res.statusCode = response.status;
            response.headers.forEach((v, k) => res.setHeader(k, v));
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), apiRoutes()],
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    // public/media is generated media (hundreds of MB) served alongside the
    // app in development; builds don't copy it.
    copyPublicDir: false,
  },
});
