export interface RpcReadRetryOptions {
  attempts: number;
  intervalMs: number;
  wait?: (milliseconds: number) => Promise<void>;
  onMiss?: (attempt: number) => void;
}

const defaultWait = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});

export async function readRpcValueWithRetry<T>(
  read: () => Promise<T | null>,
  options: RpcReadRetryOptions,
): Promise<T | null> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new Error('RPC read retry attempts must be a positive integer.');
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
    throw new Error('RPC read retry interval must be a non-negative number.');
  }

  const wait = options.wait ?? defaultWait;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const value = await read();
    if (value !== null) return value;
    options.onMiss?.(attempt);
    if (attempt < options.attempts) await wait(options.intervalMs);
  }
  return null;
}
