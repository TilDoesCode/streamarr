// Verifier JS repros (DL-N-verify1) turned around: the actual TS fake, policy and bridge, transpiled in memory.
// Run: node client/modules/offline-downloads/test-harness/js-check.cjs
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');

const client = path.resolve(__dirname, '../../..');
const ts = require(path.join(client, 'node_modules/typescript'));
require.extensions['.ts'] = (mod, filename) => {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  mod._compile(result.outputText, filename);
};
const engineDir = path.join(client, 'src/downloads/engine');
const { createFakeDownloadEngine } = require(path.join(engineDir, 'fake.ts'));
const { parseRetryAfter, httpStatusAction } = require(path.join(engineDir, 'http-policy.ts'));
const spec = { id: 'a', url: 'https://server/offline/a', relativePath: 'a', expectedBytes: 8 };
let count = 0;

async function check(label, body) {
  await body();
  count += 1;
  process.stdout.write(`PASS ${label}\n`);
}

(async () => {
  await check('status table exhaustive 100..599', () => {
    for (let status = 100; status <= 599; status += 1) {
      const retry = [408, 425, 429].includes(status) || status >= 500;
      assert.equal(httpStatusAction(status), retry ? 'retry' : 'fail');
    }
  });
  await check('huge Retry-After caps at one hour', () => {
    assert.equal(parseRetryAfter('9223372036854776'), 3600000);
    assert.equal(parseRetryAfter('9223372036854775807'), 3600000);
    assert.equal(parseRetryAfter('9'.repeat(400)), 3600000);
    assert.equal(parseRetryAfter('-5'), null);
  });
  await check('date with trailing garbage is rejected', () => {
    assert.equal(parseRetryAfter('Fri, 06 Nov 2026 20:00:40 GMT garbage', 1793995200000), null);
  });
  await check('Retry-After 0 waits 2 s', () => {
    assert.equal(parseRetryAfter('0'), 2000);
  });
  // Was "BUG fake retry does not restart after retryAt".
  await check('fake restarts a retrying task after retryAt and fails after eight attempts', async () => {
    let now = 0;
    const engine = createFakeDownloadEngine({ now: () => now });
    await engine.start(spec);
    engine.controls.httpStatus('a', 503);
    now = 100000;
    await engine.setMaxConcurrent(2);
    assert.equal((await engine.get('a')).state, 'running');
    for (let i = 0; i < 7; i += 1) {
      engine.controls.httpStatus('a', 503);
      now = (await engine.get('a')).retryAt ?? now;
      engine.controls.tick();
    }
    assert.equal((await engine.get('a')).attempts, 8);
    assert.equal((await engine.get('a')).state, 'failed');
  });
  // Was "BUG fake omits native 64MiB storage reserve".
  await check('fake keeps the native 64 MiB reserve', async () => {
    const engine = createFakeDownloadEngine({ storage: { freeBytes: 8, totalBytes: 100 } });
    const task = await engine.start(spec);
    assert.equal(task.state, 'failed');
    assert.equal(task.error.kind, 'disk_full');
  });
  // Was "BUG fake accepts missing volume".
  await check('fake rejects an unknown volume', async () => {
    const engine = createFakeDownloadEngine();
    await assert.rejects(engine.start({ ...spec, volumeId: 'missing' }), { code: 'not_found' });
  });
  // Was "BUG fake completion omits native final progress event".
  await check('fake emits completed, then one final progress', async () => {
    const engine = createFakeDownloadEngine();
    const events = [];
    engine.addProgressListener(() => events.push('progress'));
    engine.addStateListener((event) => {
      if (event.state === 'completed') events.push('completed');
    });
    await engine.start(spec);
    engine.controls.complete('a');
    assert.deepEqual(events, ['completed', 'progress']);
  });
  // Was "BUG fake recursively deletes files but fails to restore storage".
  await check('fake gives storage back for a recursive delete', async () => {
    const engine = createFakeDownloadEngine({ storage: { freeBytes: 1000000000, totalBytes: 2000000000 } });
    await engine.start({ ...spec, relativePath: 'dir/a' });
    engine.controls.complete('a');
    await engine.remove('a');
    await engine.deletePath('dir');
    assert.equal(await engine.exists('dir/a'), false);
    assert.equal((await engine.storage()).freeBytes, 1000000000);
  });
  // Was "BUG bridge truncates unrecognized native error message".
  await check('bridge keeps an unrecognized native error message', () => {
    const originalLoad = Module._load;
    global.__DEV__ = false;
    Module._load = function (name, ...args) {
      if (name === 'expo') return { requireOptionalNativeModule: () => null };
      if (name === 'react-native') return { Platform: { OS: 'web', isTV: false } };
      return originalLoad.call(this, name, ...args);
    };
    try {
      const bridge = require(path.join(engineDir, 'index.ts'));
      assert.equal(bridge.toDownloadEngineError(new Error('disk unavailable')).message, 'io: disk unavailable');
      assert.equal(bridge.platformSupportsDownloads('web', false), false);
      assert.equal(bridge.platformSupportsDownloads('ios', true), false);
      assert.equal(bridge.platformSupportsDownloads('android', true), true);
    } finally {
      Module._load = originalLoad;
    }
  });
  console.log(`JS harness: ${count}/${count} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
