import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../docs/', import.meta.url));
const resolvedRoot = path.resolve(root);
const port = process.env.HF_PREVIEW_PORT === undefined ? 8080 : Number(process.env.HF_PREVIEW_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HF_PREVIEW_PORTが不正です。');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (file !== resolvedRoot && !file.startsWith(resolvedRoot + path.sep)) {
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
server.listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port + '/ (停止: Ctrl+C)'));
