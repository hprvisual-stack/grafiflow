import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { publicGrafiflowConfigScript } from '../server/public-config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
if (!existsSync(root)) throw new Error('Execute npm run build antes de abrir a prévia.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname.replace(/\/$/, '') === '/api/config') {
    response.writeHead(request.method === 'GET' ? 200 : 405, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      ...(request.method === 'GET' ? {} : { Allow: 'GET' }),
    });
    response.end(request.method === 'GET' ? publicGrafiflowConfigScript() : 'Method Not Allowed');
    return;
  }
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1));
  const path = resolve(root, relative);
  if ((path !== root && !path.startsWith(`${root}${sep}`)) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404).end('Não encontrado');
    return;
  }
  response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(path).pipe(response);
});
server.listen(4173, '127.0.0.1', () => console.log('Prévia GrafiFlow: http://127.0.0.1:4173'));
