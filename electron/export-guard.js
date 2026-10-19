// Tracks the one export that may be running, so window-close can cancel it and
// wait for ffmpeg/temp-dir cleanup instead of quitting underneath it.
function waitForSettled(promise, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (settled) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(settled);
    };
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    if (timer.unref) timer.unref();
    Promise.resolve(promise).then(() => finish(true), () => finish(true));
  });
}

function createExportGuard() {
  let active = null;
  const clear = (p) => { if (active === p) active = null; };

  return {
    begin(promise) {
      const p = Promise.resolve(promise);
      active = p;
      p.then(() => clear(p), () => clear(p));
      return p;
    },
    get exporting() { return active !== null; },
    // Call the cancel hook, then wait (bounded) for the run's cleanup/finally.
    async cancelAndWait(cancelFn, timeoutMs = 10000) {
      if (!active) return;
      const p = active;
      try { if (cancelFn) cancelFn(); } catch (_) { /* keep closing */ }
      const settled = await waitForSettled(p, timeoutMs);
      if (!settled) clear(p); // don't block shutdown on a wedged child forever
    },
  };
}

module.exports = { createExportGuard };
