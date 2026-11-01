/* 重い列挙をメインスレッドから切り離すための Web Worker */
importScripts('engine.js');

self.onmessage = function (ev) {
  const msg = ev.data;
  try {
    if (msg.type === 'run') {
      let last = 0;
      const result = LeagueEngine.run(msg.problem, msg.opts, function (done, total) {
        const now = Date.now();
        if (now - last < 100) return;
        last = now;
        self.postMessage({ type: 'progress', done: done, total: total });
      });
      self.postMessage({ type: 'result', result: result });
    } else if (msg.type === 'detail') {
      self.postMessage({ type: 'result', result: LeagueEngine.detail(msg.problem, msg.opts) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
