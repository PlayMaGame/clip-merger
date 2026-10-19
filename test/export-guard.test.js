const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createExportGuard } = require('../electron/export-guard');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('cancelAndWait cancels the active export and waits for it to settle', async () => {
  const guard = createExportGuard();
  const job = deferred();
  guard.begin(job.promise);
  assert.equal(guard.exporting, true);

  let cancelled = false;
  const waiting = guard.cancelAndWait(() => { cancelled = true; });
  assert.equal(cancelled, true);

  let done = false;
  waiting.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false); // still cleaning up

  job.reject(new Error('Export cancelled'));
  await waiting;
  assert.equal(guard.exporting, false);
});

test('cancelAndWait does nothing when no export is running', async () => {
  const guard = createExportGuard();
  let cancelled = false;
  await guard.cancelAndWait(() => { cancelled = true; });
  assert.equal(cancelled, false);
  assert.equal(guard.exporting, false);
});

test('cancelAndWait does not hang forever if the export never settles', async () => {
  const guard = createExportGuard();
  const job = deferred();
  guard.begin(job.promise);
  const started = Date.now();
  await guard.cancelAndWait(() => {}, 30);
  assert.ok(Date.now() - started < 500);
  assert.equal(guard.exporting, false);
});
