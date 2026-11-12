/**
 * Wait for work for at most 10 seconds, or 1 second once signal aborts, so Pi never waits
 * on Sovara. The work itself keeps running; its late failure is ignored.
 */
export function bounded<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const expire = () => {
      const error = new Error("Sovara did not respond in time");
      error.name = "TimeoutError";
      reject(error);
    };
    let timer = setTimeout(expire, 10000);
    const shorten = () => {
      clearTimeout(timer);
      timer = setTimeout(expire, Math.max(0, Math.min(1000, deadline - Date.now())));
    };
    if (signal?.aborted) shorten();
    else signal?.addEventListener("abort", shorten, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", shorten);
    });
  });
}
