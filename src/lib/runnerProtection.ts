export type RunnerSide = 1 | -1;

// Protection milestones are earlier than the previous v35 schedule.
// They remain anchored to the immutable entry -> target distance, but now
// correspond to roughly 1R / 2R / 3R on a 10R target and 1.5R / 3R / 4.5R
// on a 15R target. The previous 1.25R / 2.5R / 4R (10R) schedule, and its
// even later equivalent for 15R, delayed protection too far into the move.
export const RUNNER_BREAKEVEN_FRACTION = 0.10;
export const RUNNER_COST_BUFFER_FRACTION = 0.003;
export const RUNNER_LOCK_FRACTION = 0.20;
export const RUNNER_LOCK_KEEP_FRACTION = 0.05;
export const RUNNER_TRAIL_START_FRACTION = 0.30;
export const RUNNER_TRAIL_GIVEBACK_FRACTION = 0.10;

/**
 * Monotonically ratchets the stop after favorable movement.
 *
 * The calculation is anchored to entry -> target, not the mutable stop,
 * so moving the stop cannot corrupt the definition of progress.
 * The returned stop can only move in the profitable direction.
 */
export function runnerProtectedStop(
  side: RunnerSide,
  entry: number,
  target: number,
  currentStop: number,
  barHigh: number,
  barLow: number,
): number {
  const distanceToTarget = Math.abs(target - entry);
  if (!(distanceToTarget > 0) || ![entry, target, currentStop, barHigh, barLow].every(Number.isFinite)) {
    return currentStop;
  }

  const favorable = side === 1 ? barHigh - entry : entry - barLow;
  const fraction = favorable / distanceToTarget;
  let desired = currentStop;

  if (fraction >= RUNNER_TRAIL_START_FRACTION) {
    desired = entry + side * (fraction - RUNNER_TRAIL_GIVEBACK_FRACTION) * distanceToTarget;
  } else if (fraction >= RUNNER_LOCK_FRACTION) {
    desired = entry + side * RUNNER_LOCK_KEEP_FRACTION * distanceToTarget;
  } else if (fraction >= RUNNER_BREAKEVEN_FRACTION) {
    desired = entry + side * RUNNER_COST_BUFFER_FRACTION * distanceToTarget;
  }

  return side === 1 ? Math.max(currentStop, desired) : Math.min(currentStop, desired);
}
