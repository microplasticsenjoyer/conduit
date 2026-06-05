// Minimal module-level pub/sub for transient toast notifications.
// Any component calls showToast(message); the single mounted <Toast /> renders it.

const listeners = new Set();
let counter = 0;

export function showToast(message) {
  counter += 1;
  const toast = { id: counter, message };
  for (const cb of listeners) cb(toast);
}

export function subscribeToast(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
