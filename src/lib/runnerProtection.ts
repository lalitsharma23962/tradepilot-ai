export type RunnerSide = 1 | -1;

// Runner protection is deliberately slower than the previous 1R/2R/3R
// schedule. The research target remains 10R/15R; protection should preserve
// enough of a genuine large winner to make those targets economically useful.
export const RUNNER_BREAKEVEN_R = 1.25;
export const RUNNER_LOCK_R = 2.5;
export const RUNNER_LOCK_KEEP_R = 1.0;
export const RUNNER_TRAIL_START_R = 5.0;
export const RUNNER_TRAIL_GIVEBACK_R = 1.5;
export const RUNNER_COST_BUFFER_R = 0.05;

/**
 * Monotonically ratchets the stop after favorable movement.
 *
 * Progress is measured in immutable initial-risk R multiples, not as a
 * fraction of the mutable stop or target. This keeps protection consistent
 * for both 10R and 15R research targets and prevents early trailing from
 * converting normal 3R-5R pullbacks into small winners.
 */
export function runnerProtectedStop(
  side: RunnerSide,
  entry: number,
  initialRisk: number,
  currentStop: number,
  barHigh: number,
  barLow: number,
): number {
  if (!(initialRisk > 0) || ![entry, initialRisk, currentStop, barHigh, barLow].every(Number.isFinite)) {
    return currentStop;
  }

  const favorable = side === 1 ? barHigh - entry : entry - barLow;
  const favorableR = favorable / initialRisk;
  let desired = currentStop;

  if (favorableR >= RUNNER_TRAIL_START_R) {
    desired = entry + side * (favorableR - RUNNER_TRAIL_GIVEBACK_R) * initialRisk;
  } else if (favorableR >= RUNNER_LOCK_R) {
    desired = entry + side * RUNNER_LOCK_KEEP_R * initialRisk;
  } else if (favorableR >= RUNNER_BREAKEVEN_R) {
    desired = entry + side * RUNNER_COST_BUFFER_R * initialRisk;
  }

  return side === 1 ? Math.max(currentStop, desired) : Math.min(currentStop, desired);
}
