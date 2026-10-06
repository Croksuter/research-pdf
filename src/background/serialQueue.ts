// ─── One-at-a-time task queue ───
//
// Each background store does its read-modify-writes through its own queue, so
// two messages arriving together cannot interleave and drop each other's
// change. A failed task does not stall the ones after it.

export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
