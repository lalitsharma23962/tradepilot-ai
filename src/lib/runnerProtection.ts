export type RunnerSide = 1 | -1;

// Protect profitable runners earlier while keeping the milestones anchored to
// the immutable entry-to-target distance. This avoids reconstructing R from a
// mutable stop and works identically for 10R and 15R targets.
//
// 10% of target distance = 1R on a 10R target (1.5R on a 15R target).
// 20% = 2R / 3R, and trailing begins at 30% = 3R / 4.5R.
export const RUNNER_BREAKEVEN_TARGET_FRACTION = 0.10;
export const RUNNER_LOCK_TARGET_FRACTION = 0.20;
export const RUNNER_LOCK_KEEP_TARGET_FRACTION = 0.05;
export const RUNNER_TRAIL_START_TARGET_FRACTION = 0.30;
export const RUNNER_TRAIL_GIVEBACK_TARGET_FRACTION = 0.10;
export const RUNNER_COST_BUFFER_TARGET_FRACTION = 0.003;

/**
 * Monotonically ratchet the stop after favorable movement.
 *
 * `target` is the immutable take-profit price. Progress is measured against
 * entry -> target, never against the mutable stop. The returned stop can only
 * move in the profitable direction.
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
  const favorableTargetFraction = favorable / targetDistance;
  let desired = currentStop;

  if (favorableTargetFraction >= RUNNER_TRAIL_START_TARGET_FRACTION) {
    desired = entry + side * (favorableTargetFraction - RUNNER_TRAIL_GIVEBACK_TARGET_FRACTION) * targetDistance;
  } else if (favorableTargetFraction >= RUNNER_LOCK_TARGET_FRACTION) {
    desired = entry + side * RUNNER_LOCK_KEEP_TARGET_FRACTION * targetDistance;
  } else if (favorableTargetFraction >= RUNNER_BREAKEVEN_TARGET_FRACTION) {
    desired = entry + side * RUNNER_COST_BUFFER_TARGET_FRACTION * targetDistance;
  }

  return side === 1 ? Math.max(currentStop, desired) : Math.min(currentStop, desired);
}
