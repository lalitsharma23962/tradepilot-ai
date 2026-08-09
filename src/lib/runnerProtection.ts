export type RunnerSide = 1 | -1;

// Protection is anchored to the immutable entry-to-target distance. This is
// important because the persisted stop is mutable: using it to reconstruct R
// would make the risk unit shrink every time the stop ratchets.
export const RUNNER_BREAKEVEN_TARGET_FRACTION = 0.125;
export const RUNNER_LOCK_TARGET_FRACTION = 0.25;
export const RUNNER_LOCK_KEEP_TARGET_FRACTION = 0.10;
export const RUNNER_TRAIL_START_TARGET_FRACTION = 0.50;
export const RUNNER_TRAIL_GIVEBACK_TARGET_FRACTION = 0.15;

/**
 * Monotonically ratchet the stop after favorable movement.
 *
 * The third argument is the immutable take-profit price, not the mutable
 * stop-loss and not an absolute price mistakenly treated as an R-unit.
 * Milestones are fractions of the entry-to-target distance, so the same
 * protection scales for both 10R and 15R research targets without needing a
 * new database column for initial risk.
 */
export function runnerProtectedStop(
  side: RunnerSide,
  entry: number,
  target: number,
  currentStop: number,
  barHigh: number,
  barLow: number,
): number {
  if (!(Math.abs(target - entry) > 0) || ![entry, target, currentStop, barHigh, barLow].every(Number.isFinite)) {
    return currentStop;
  }

  const targetDistance = Math.abs(target - entry);
  const favorable = side === 1 ? barHigh - entry : entry - barLow;
  const favorableTargetFraction = favorable / targetDistance;
  let desired = currentStop;

  if (favorableTargetFraction >= RUNNER_TRAIL_START_TARGET_FRACTION) {
    desired = entry + side * (favorableTargetFraction - RUNNER_TRAIL_GIVEBACK_TARGET_FRACTION) * targetDistance;
  } else if (favorableTargetFraction >= RUNNER_LOCK_TARGET_FRACTION) {
    desired = entry + side * RUNNER_LOCK_KEEP_TARGET_FRACTION * targetDistance;
  } else if (favorableTargetFraction >= RUNNER_BREAKEVEN_TARGET_FRACTION) {
    desired = entry + side * 0.01 * targetDistance;
  }

  return side === 1 ? Math.max(currentStop, desired) : Math.min(currentStop, desired);
}
