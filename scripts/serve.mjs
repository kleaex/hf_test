import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../docs/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
server.on('error', error => {
  console.error('起動できませんでした:', error.message);
  process.exitCode = 1;
});
server.listen(8080, '127.0.0.1', () => console.log('http://127.0.0.1:8080/ (停止: Ctrl+C)'));