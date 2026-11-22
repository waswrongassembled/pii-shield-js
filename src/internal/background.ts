/**
 * Background work shared by createPiiShield() and the service (serviceFromEnv()): the periodic purge of
 * expired vault entries and the default report of its errors.
 */

/**
 * `Name CODE` of an error, for log lines. Never the message: driver and provider messages can quote
 * values (a pg error's `detail`, a provider echoing the request text).
 */
export function describeError(error: unknown): string {
  const { name = 'Error', code } = (error ?? {}) as { name?: unknown; code?: unknown };

  return `${typeof name === 'string' ? name : 'Error'}${typeof code === 'string' ? ` ${code}` : ''}`;
}

/** The default `onError`: one line to stderr with the task, the error's name and code, nothing else. */
export function reportToStderr(error: unknown, task: string): void {
  process.stderr.write(`pii-shield: ${task} failed (${describeError(error)})\n`);
}

/** Seconds between two purges of expired vault entries, unless configured otherwise. */
export const DEFAULT_PURGE_INTERVAL = 300;
/** The longest purge interval accepted: one day. */
export const MAX_PURGE_INTERVAL = 86_400;

export interface PurgeSchedule {
  /** Stops the timer and waits for a purge that is running. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Runs `purge` at once and then every `intervalSeconds`, on an unref'd timer (it never keeps the process
 * alive). Purges never overlap: a tick while one is running is skipped. Failures go to `onError`.
 *
 * Expired entries are personal data past their storage period (Art. 5(1)(e) GDPR): they must really be
 * deleted, not only hidden by the read filter.
 */
export function schedulePurge(
  purge: () => Promise<unknown>,
  intervalSeconds: number,
  onError: (error: unknown) => void,
): PurgeSchedule {
  let running: Promise<void> | undefined;
  const run = (): void => {
    running ??= purge()
      .then(
        () => undefined,
        (e: unknown) => {
          onError(e);
        },
      )
      .finally(() => {
        running = undefined;
      });
  };
  run();
  const timer = setInterval(run, intervalSeconds * 1000).unref();

  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
