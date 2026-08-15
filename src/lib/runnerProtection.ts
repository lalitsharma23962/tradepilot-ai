export type RunnerSide = 1 | -1;

// v38 production protection: milestones are expressed in R so they remain
// aligned with the fixed 1R / 1.5R / 2R target ladder.
// Breakeven is not armed by tiny intrabar noise; it starts only after 1R.
// Trailing begins only after 1.5R has been reached.
export const RUNNER_BREAKEVEN_TRIGGER_R = 1.00;
export const RUNNER_BREAKEVEN_OFFSET_R = 0.05;
export const RUNNER_TRAILING_START_R = 1.50;
export const RUNNER_TRAILING_GIVEBACK_R = 0.35;

/**
 * Monotonically ratchet the stop after favorable movement.
 *
 * `target` is the immutable take-profit price. Progress is measured against
 * entry -> target so the calculation is independent of the mutable stop.
 */
export function runnerProtectedStop(
  side: RunnerSide,
  entry: number,
  target: number,
  currentStop: number,
  barHigh: number,
  barLow: number,
): number {
  const targetDistance = Math.abs(target - entry);
  if (!(targetDistance > 0) || ![entry, target, currentStop, barHigh, barLow].every(Number.isFinite)) {
    return currentStop;
  }

  const favorable = side === 1 ? barHigh - entry : entry - barLow;
  const favorableR = favorable / targetDistance * 2;
  let desired = currentStop;

  if (favorableR >= RUNNER_TRAILING_START_R) {
    desired = entry + side * (favorableR - RUNNER_TRAILING_GIVEBACK_R) * (targetDistance / 2);
  } else if (favorableR >= RUNNER_BREAKEVEN_TRIGGER_R) {
    desired = entry + side * RUNNER_BREAKEVEN_OFFSET_R * (targetDistance / 2);
  }

  return side === 1 ? Math.max(currentStop, desired) : Math.min(currentStop, desired);
}
