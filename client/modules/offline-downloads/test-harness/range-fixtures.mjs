// The repository Range server plus two redirect routes for the credential-scope check (N1-12).
// Usage: node range-fixtures.mjs --host 127.0.0.1 --port 39321 (redirects 127.0.0.1 → localhost on the same port).
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

const sourceURL = new URL('../../../scripts/download-test-server.mjs', import.meta.url);
let source = readFileSync(sourceURL, 'utf8');
const portIndex = process.argv.indexOf('--port');
const port = portIndex > 0 ? process.argv[portIndex + 1] : '39320';
const needle = "    const url = new URL(req.url ?? '/', 'http://localhost');";
if (source.split(needle).length !== 2) throw new Error('Range server insertion point changed');
source = source.replace(
  needle,
  needle +
    `
    if (url.pathname === '/__verify/redirect') {
      res.writeHead(302, { Location: 'http://localhost:${port}/__verify/capture' }).end();
      return;
    }
    if (url.pathname === '/__verify/capture') {
      const body = JSON.stringify(req.headers);
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(body), ETag: '"capture"' }).end(body);
      return;
    }
`
);
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
