// 要求ごとに破棄する。入力・メール・ID・URL・トークンは記録しない。
let HF_REQUEST_ = null;

function cacheEvent_(name) {
  if (HF_REQUEST_) HF_REQUEST_.cache[name] = (HF_REQUEST_.cache[name] || 0) + 1;
}

function timed_(name, operation) {
  const start = Date.now();
  try { return operation(); }
  finally {
    if (HF_REQUEST_) {
      const entry = HF_REQUEST_.stages[name] || { ms: 0, count: 0 };
      entry.ms += Date.now() - start; entry.count++;
      HF_REQUEST_.stages[name] = entry;
    }
  }
}

function freshRequestConfig_() {
  if (HF_REQUEST_) { HF_REQUEST_.config = null; HF_REQUEST_.sheets = {}; }
}
