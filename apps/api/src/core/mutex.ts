/**
 * Per-key async mutex for the in-memory (local) driver.
 *
 * Node is single-threaded, but a read -> await (scrypt, I/O) -> write sequence is NOT atomic: other requests run in
 * the gaps. The PostgreSQL driver closes that gap with a single UPDATE ... RETURNING; this gives the local driver the
 * same guarantee, so both drivers behave identically under concurrency.
 *
 * Critical sections for one key run strictly one at a time, in arrival order; different keys never block each other;
 * a throwing section releases the lock.
 */
const tails = new Map<string, Promise<void>>();

export async function withUserLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
