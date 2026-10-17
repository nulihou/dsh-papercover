import type { AbortLike } from './types.js';

export function throwIfCancelled(signal?: AbortLike | null): void {
  if (signal?.aborted) throw new Error('任务已取消');
}

/**
 * 把 AbortLike 桥接成真实 AbortSignal 注入 provider。
 * 优先复用 handle.signal；否则退回 100ms 轮询（兼容旧 { aborted } 对象）。
 */
export function providerSignal(signal?: AbortLike | null): { signal?: AbortSignal; dispose(): void } {
  if (!signal) return { dispose() {} };
  if (signal.signal) {
    if (signal.aborted && !signal.signal.aborted) {
      /* handle 已 aborted 但 signal 偶发不同步时仍交给 provider */
    }
    return { signal: signal.signal, dispose() {} };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  if (signal.aborted) controller.abort();
  else {
    timer = setInterval(() => {
      if (signal.aborted) {
        controller.abort();
        if (timer) clearInterval(timer);
      }
    }, 100);
  }
  return {
    signal: controller.signal,
    dispose() { if (timer) clearInterval(timer); },
  };
}
