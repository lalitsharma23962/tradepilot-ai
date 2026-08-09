export type RunnerSide = 1 | -1;

// Milestones are fractions of the immutable entry-to-target distance.
// 0.125 of a 10R target = 1.25R; 0.25 = 2.5R; 0.40 = 4R.
export const RUNNER_BREAKEVEN_FRACTION = 0.125;
export const RUNNER_COST_BUFFER_FRACTION = 0.003;
export const RUNNER_LOCK_FRACTION = 0.25;
export const RUNNER_LOCK_KEEP_FRACTION = 0.10;
export const RUNNER_TRAIL_START_FRACTION = 0.40;
export const RUNNER_TRAIL_GIVEBACK_FRACTION = 0.15;

/** Monotonically ratchet the stop using immutable entry-to-target progress. */
export function runnerProtectedStop(
  side: RunnerSide,
  entry: number,
  target: number,
  currentStop: number,
  barHigh: number,
  barLow: number,
): number {
  const distanceToTarget = Math.abs(target - entry);
  if (!(distanceToTarget > 0) || ![entry, target, currentStop, barHigh, barLow].every(Number.isFinite)) return currentStop;
  const favorable = side === 1 ? barHigh - entry : entry - barLow;
  const fraction = favorable / distanceToTarget;
  let desired = currentStop;
  if (fraction >= RUNNER_TRAIL_START_FRACTION) desired = entry + side * (fraction - RUNNER_TRAIL_GIVEBACK_FRACTION) * distanceToTarget;
  else if (fraction >= RUNNER_LOCK_FRACTION) desired = entry + side * RUNNER_LOCK_KEEP_FRACTION * distanceToTarget;
  else if (fraction >= RUNNER_BREAKEVEN_FRACTION) desired = entry + side * RUNNER_COST_BUFFER_FRACTION * distanceToTarget;
  return side === 1 ? Math.max(currentStop, desired) : Math.min(currentStop, desired);
}
