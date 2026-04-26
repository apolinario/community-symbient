/**
 * Tiny `sleep` utility used by retry-backoff loops and similar pacing.
 * Centralised so callers can use a single named helper instead of inlined
 * timer-promise expressions.
 */
export function sleep(ms: number): Promise<void> {
  const timer = (resolve: () => void) => setTimeout(resolve, ms);
  return new Promise(timer);
}
