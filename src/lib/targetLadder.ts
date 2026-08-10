export interface TargetLevel {
  r: number;
  fraction: number;
}

/**
 * Fixed 1:2 risk/reward plan with four partial exits.
 * The final target is exactly 2R; partial targets monetize movement sooner.
 */
export const TARGET_LADDER: readonly TargetLevel[] = [
  { r: 0.5, fraction: 0.25 },
  { r: 1.0, fraction: 0.25 },
  { r: 1.5, fraction: 0.25 },
  { r: 2.0, fraction: 0.25 },
] as const;

export const FINAL_TARGET_R = 2;

export function targetPrice(side: 1 | -1, entry: number, risk: number, r: number): number {
  return entry + side * risk * r;
}

/**
 * After each partial target, ratchet the stop without ever moving it backward.
 * TP1 -> breakeven, TP2 -> +0.5R, TP3 -> +1R, TP4 closes the remainder.
 */
export function protectedStopAfterTarget(
  side: 1 | -1,
  entry: number,
  risk: number,
  stage: number,
  currentStop: number,
): number {
  if (!(risk > 0) || !Number.isFinite(entry) || !Number.isFinite(currentStop)) return currentStop;
  const lockR = stage >= 3 ? 1 : stage >= 2 ? 0.5 : stage >= 1 ? 0 : -Infinity;
  if (!Number.isFinite(lockR)) return currentStop;
  const desired = entry + side * risk * lockR;
  return side === 1 ? Math.max(currentStop, desired) : Math.min(currentStop, desired);
}
