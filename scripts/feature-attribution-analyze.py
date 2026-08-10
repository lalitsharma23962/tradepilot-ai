#!/usr/bin/env python3
"""
Feature-attribution analysis for v38 diagnostic records.
Reads diagnostics/feature-attribution-*.jsonl and produces a statistical report.
"""
import json
import glob
import math
import os
import sys
from collections import defaultdict
from typing import List, Dict, Any, Optional, Callable


def load_records(data_dir: str = "diagnostics") -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []
    for path in sorted(glob.glob(os.path.join(data_dir, "feature-attribution-*.jsonl"))):
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
    return records


def accepted(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [r for r in records if r.get("action") != "WAIT" and r.get("netExpectedR") is not None]


def spearman(xs: List[float], ys: List[float]) -> float:
    n = len(xs)
    if n < 3:
        return float("nan")
    rx = rank(xs)
    ry = rank(ys)
    return pearson(rx, ry)


def pearson(xs: List[float], ys: List[float]) -> float:
    n = len(xs)
    if n < 3:
        return float("nan")
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    denx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    deny = math.sqrt(sum((y - my) ** 2 for y in ys))
    if denx == 0 or deny == 0:
        return float("nan")
    return num / (denx * deny)


def rank(xs: List[float]) -> List[float]:
    sorted_idx = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(sorted_idx):
        j = i
        while j + 1 < len(sorted_idx) and xs[sorted_idx[j + 1]] == xs[sorted_idx[i]]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[sorted_idx[k]] = avg_rank
        i = j + 1
    return ranks


def bootstrap_ci(values: List[float], stat: Callable[[List[float]], float], n_iter: int = 2000, ci: float = 0.95) -> tuple:
    if len(values) < 5:
        return (float("nan"), float("nan"))
    import random
    rng = random.Random(42)
    stats = []
    for _ in range(n_iter):
        sample = [values[rng.randrange(len(values))] for _ in range(len(values))]
        stats.append(stat(sample))
    stats.sort()
    lo = int((1 - ci) / 2 * n_iter)
    hi = int((1 + ci) / 2 * n_iter)
    return (stats[lo], stats[hi])


def mean(values: List[float]) -> float:
    return sum(values) / len(values) if values else float("nan")


def median(values: List[float]) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    n = len(s)
    if n % 2 == 1:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


def stddev(values: List[float]) -> float:
    if len(values) < 2:
        return float("nan")
    m = mean(values)
    return math.sqrt(sum((x - m) ** 2 for x in values) / (len(values) - 1))


def quantile_cut(values: List[float], n_bins: int = 10) -> List[tuple]:
    """Return list of (lo, hi) thresholds for each quantile bin."""
    if len(values) < n_bins:
        return []
    sorted_vals = sorted(values)
    cuts = []
    for k in range(n_bins):
        idx_lo = int(k * len(sorted_vals) / n_bins)
        idx_hi = int((k + 1) * len(sorted_vals) / n_bins) - 1
        if idx_hi < idx_lo:
            idx_hi = idx_lo
        cuts.append((sorted_vals[idx_lo], sorted_vals[idx_hi]))
    return cuts


def bucket_by_feature(records: List[Dict[str, Any]], feature: str, n_bins: int = 10) -> List[Dict[str, Any]]:
    values = [r[feature] for r in records if feature in r and r[feature] is not None and math.isfinite(r[feature])]
    if len(values) < n_bins * 3:
        return []
    cuts = quantile_cut(values, n_bins)
    rows = []
    for k, (lo, hi) in enumerate(cuts):
        if k == n_bins - 1:
            bucket = [r for r in records if feature in r and r[feature] is not None and math.isfinite(r[feature]) and r[feature] >= lo and r[feature] <= hi]
        else:
            bucket = [r for r in records if feature in r and r[feature] is not None and math.isfinite(r[feature]) and r[feature] >= lo and r[feature] < hi]
        if not bucket:
            continue
        n = len(bucket)
        avg = lambda key: sum(r.get(key, 0) or 0 for r in bucket) / n
        net_vals = [r.get("netExpectedR", 0) or 0 for r in bucket]
        ci_lo, ci_hi = bootstrap_ci(net_vals, lambda xs: sum(xs) / len(xs))
        rows.append({
            "bin": f"{k * 10}-{(k + 1) * 10}%",
            "n": n,
            "range": f"{lo:.4g} - {hi:.4g}",
            "P0": avg("P0"),
            "P1": avg("P1"),
            "P2": avg("P2"),
            "P3": avg("P3"),
            "grossExpectedR": avg("grossExpectedR"),
            "netExpectedR": avg("netExpectedR"),
            "netExpectedR_median": median(net_vals),
            "netExpectedR_std": stddev(net_vals),
            "netExpectedR_ci95": f"[{ci_lo:.4f}, {ci_hi:.4f}]",
            "selection": "post-hoc (data-driven quantile)",
        })
    return rows


def correlation_table(records: List[Dict[str, Any]], features: List[str], outcomes: List[str]) -> Dict[str, Dict[str, Dict[str, float]]]:
    result: Dict[str, Dict[str, Dict[str, float]]] = {}
    for feat in features:
        result[feat] = {}
        for out in outcomes:
            pairs = [(r[feat], r[out]) for r in records if feat in r and out in r and r[feat] is not None and r[out] is not None and math.isfinite(r[feat]) and math.isfinite(r[out])]
            if len(pairs) < 10:
                result[feat][out] = {"n": len(pairs), "spearman": float("nan"), "pearson": float("nan")}
                continue
            xs, ys = zip(*pairs)
            result[feat][out] = {
                "n": len(pairs),
                "spearman": spearman(list(xs), list(ys)),
                "pearson": pearson(list(xs), list(ys)),
            }
    return result


def conditional_pockets(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Test a small set of interpretable hypotheses."""
    hypotheses = [
        ("compression + expanding + volumeExpansion", lambda r: r.get("compression") and r.get("expanding") and r.get("volumeExpansion")),
        ("compression + expanding (any volume)", lambda r: r.get("compression") and r.get("expanding")),
        ("breakoutLong + emaAlignedUp + momentumLong", lambda r: r.get("breakoutLong") and r.get("emaAlignedUp") and r.get("momentumLong")),
        ("breakoutShort + emaAlignedDown + momentumShort", lambda r: r.get("breakoutShort") and r.get("emaAlignedDown") and r.get("momentumShort")),
        ("reclaimLong + pullbackLong + hourlyLong", lambda r: r.get("reclaimLong") and r.get("pullbackLong") and r.get("hourlyLong")),
        ("reclaimShort + pullbackShort + hourlyShort", lambda r: r.get("reclaimShort") and r.get("pullbackShort") and r.get("hourlyShort")),
        ("adx > 25 + breakout", lambda r: (r.get("adx") or 0) > 25 and (r.get("breakoutLong") or r.get("breakoutShort"))),
        ("adx > 25 + compression + expanding", lambda r: (r.get("adx") or 0) > 25 and r.get("compression") and r.get("expanding")),
        ("volumeExpansion + breakout", lambda r: r.get("volumeExpansion") and (r.get("breakoutLong") or r.get("breakoutShort"))),
        ("rsi 30-50 + reclaimLong + compression", lambda r: 30 <= (r.get("rsi") or 0) <= 50 and r.get("reclaimLong") and r.get("compression")),
        ("rsi 50-70 + reclaimShort + compression", lambda r: 50 <= (r.get("rsi") or 0) <= 70 and r.get("reclaimShort") and r.get("compression")),
    ]
    rows = []
    for name, pred in hypotheses:
        bucket = [r for r in records if pred(r)]
        if len(bucket) < 10:
            continue
        n = len(bucket)
        net_vals = [r.get("netExpectedR", 0) or 0 for r in bucket]
        avg_net = mean(net_vals)
        ci_lo, ci_hi = bootstrap_ci(net_vals, lambda xs: sum(xs) / len(xs))
        rows.append({
            "hypothesis": name,
            "n": n,
            "avg_P0": sum(r.get("P0", 0) or 0 for r in bucket) / n,
            "avg_P1": sum(r.get("P1", 0) or 0 for r in bucket) / n,
            "avg_P2": sum(r.get("P2", 0) or 0 for r in bucket) / n,
            "avg_P3": sum(r.get("P3", 0) or 0 for r in bucket) / n,
            "avg_netExpectedR": avg_net,
            "median_netExpectedR": median(net_vals),
            "std_netExpectedR": stddev(net_vals),
            "ci95_netExpectedR": f"[{ci_lo:.4f}, {ci_hi:.4f}]",
            "selection": "pre-specified (hypothesis list)",
        })
    rows.sort(key=lambda x: x["avg_netExpectedR"], reverse=True)
    return rows


def score_validation(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    pairs_p0 = [(r["rawScore"], r["P0"]) for r in records if r.get("rawScore") is not None and r.get("P0") is not None]
    pairs_p3 = [(r["rawScore"], r["P3"]) for r in records if r.get("rawScore") is not None and r.get("P3") is not None]
    pairs_net = [(r["rawScore"], r["netExpectedR"]) for r in records if r.get("rawScore") is not None and r.get("netExpectedR") is not None]

    def report(pairs):
        if len(pairs) < 10:
            return {"n": len(pairs), "spearman": float("nan"), "pearson": float("nan")}
        xs, ys = zip(*pairs)
        return {"n": len(pairs), "spearman": spearman(list(xs), list(ys)), "pearson": pearson(list(xs), list(ys))}

    # Decile difference
    sorted_by_score = sorted(records, key=lambda r: r.get("rawScore", 0) or 0)
    n = len(sorted_by_score)
    decile_size = max(1, n // 10)
    lowest = sorted_by_score[:decile_size]
    highest = sorted_by_score[-decile_size:]
    lowest_net = sum(r.get("netExpectedR", 0) or 0 for r in lowest) / len(lowest) if lowest else float("nan")
    highest_net = sum(r.get("netExpectedR", 0) or 0 for r in highest) / len(highest) if highest else float("nan")

    return {
        "rawScore_vs_P0": report(pairs_p0),
        "rawScore_vs_P3": report(pairs_p3),
        "rawScore_vs_netExpectedR": report(pairs_net),
        "lowest_decile_netExpectedR": lowest_net,
        "highest_decile_netExpectedR": highest_net,
        "decile_spread": highest_net - lowest_net,
    }


def main():
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "diagnostics"
    records = load_records(data_dir)
    sig = accepted(records)

    print("# v38 Feature-Attribution Report\n")
    print(f"Total bars evaluated: {len(records)}")
    print(f"Accepted signals with path outcomes: {len(sig)}\n")

    if not sig:
        print("No accepted signals found. Cannot perform attribution.")
        return

    # Overall path distribution
    print("## Overall Path Distribution\n")
    for k in ["P0", "P1", "P2", "P3"]:
        avg = sum(r.get(k, 0) or 0 for r in sig) / len(sig)
        print(f"- {k}: {avg:.3%}")
    net_vals = [r.get("netExpectedR", 0) or 0 for r in sig]
    print(f"- grossExpectedR: {sum(r.get('grossExpectedR', 0) or 0 for r in sig) / len(sig):.4f}")
    print(f"- expectedTransactionCostR: {sum(r.get('expectedTransactionCostR', 0) or 0 for r in sig) / len(sig):.4f}")
    print(f"- netExpectedR: {sum(net_vals) / len(sig):.4f}")
    ci_lo, ci_hi = bootstrap_ci(net_vals, lambda xs: sum(xs) / len(xs))
    print(f"- netExpectedR 95% CI: [{ci_lo:.4f}, {ci_hi:.4f}]\n")

    # Score validation
    print("## Score Validation\n")
    sv = score_validation(sig)
    for key, val in sv.items():
        if isinstance(val, dict):
            print(f"- {key}: n={val['n']}, Spearman={val['spearman']:.3f}, Pearson={val['pearson']:.3f}")
        else:
            print(f"- {key}: {val:.4f}")
    print()

    # Correlation matrix
    continuous_features = [
        "rawScore", "distEma20Atr", "distEma50Atr", "distVwapAtr", "adx", "rsi", "rsiSlope",
        "roc12", "roc24", "longDirectionalCount", "shortDirectionalCount",
        "atr20", "atrExpansion", "currentRangeAtr", "bollingerBandwidth", "volPctOfPrice",
        "distTo20HighAtr", "distTo20LowAtr", "distSwingHighAtr", "distSwingLowAtr",
        "bodyRatio", "closeLocation", "upperWickRatio", "lowerWickRatio",
        "consecutiveBullish", "consecutiveBearish",
        "volumeRatio20", "volumePercentile20",
    ]
    outcomes = ["P0", "P1", "P2", "P3", "netExpectedR"]

    print("## Feature-Outcome Correlations\n")
    print("| Feature | n | S(P0) | S(P3) | S(netR) | P(P0) | P(P3) | P(netR) |")
    print("|---|---|---|---|---|---|---|---|")
    corr = correlation_table(sig, continuous_features, outcomes)
    for feat in continuous_features:
        if feat not in corr:
            continue
        c = corr[feat]
        print(f"| {feat} | {c['P0']['n']} | "
              f"{c['P0']['spearman']:.3f} | {c['P3']['spearman']:.3f} | {c['netExpectedR']['spearman']:.3f} | "
              f"{c['P0']['pearson']:.3f} | {c['P3']['pearson']:.3f} | {c['netExpectedR']['pearson']:.3f} |")
    print()

    # Decile buckets for key features
    print("## Decile Buckets for Key Features\n")
    key_features = ["rawScore", "adx", "rsi", "distEma20Atr", "atrExpansion", "volumeRatio20", "bodyRatio", "closeLocation"]
    for feat in key_features:
        rows = bucket_by_feature(sig, feat, 10)
        if not rows:
            continue
        print(f"### {feat}\n")
        print("| Decile | n | Range | P0 | P1 | P2 | P3 | grossR | netR | median | std | 95% CI netR | selection |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        for row in rows:
            print(f"| {row['bin']} | {row['n']} | {row['range']} | "
                  f"{row['P0']:.3f} | {row['P1']:.3f} | {row['P2']:.3f} | {row['P3']:.3f} | "
                  f"{row['grossExpectedR']:.4f} | {row['netExpectedR']:.4f} | "
                  f"{row['netExpectedR_median']:.4f} | {row['netExpectedR_std']:.4f} | "
                  f"{row['netExpectedR_ci95']} | {row['selection']} |")
        print()

    # Conditional pockets
    print("## Conditional Positive Pockets\n")
    pockets = conditional_pockets(sig)
    print("| Hypothesis | n | avg P0 | avg P1 | avg P2 | avg P3 | avg netR | median | std | 95% CI netR | selection |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for row in pockets:
        print(f"| {row['hypothesis']} | {row['n']} | "
              f"{row['avg_P0']:.3f} | {row['avg_P1']:.3f} | {row['avg_P2']:.3f} | {row['avg_P3']:.3f} | "
              f"{row['avg_netExpectedR']:.4f} | {row['median_netExpectedR']:.4f} | {row['std_netExpectedR']:.4f} | "
              f"{row['ci95_netExpectedR']} | {row['selection']} |")
    print()

    # Categorical summaries
    print("## Categorical Summaries\n")
    for key in ["family", "side"]:
        groups = defaultdict(list)
        for r in sig:
            groups[r.get(key, "unknown")].append(r)
        print(f"### {key}\n")
        print("| Group | n | avg P0 | avg P3 | avg netR |")
        print("|---|---|---|---|---|")
        for group, bucket in sorted(groups.items(), key=lambda x: sum(r.get("netExpectedR", 0) or 0 for r in x[1]) / len(x[1]), reverse=True):
            n = len(bucket)
            print(f"| {group} | {n} | "
                  f"{sum(r.get('P0', 0) or 0 for r in bucket) / n:.3f} | "
                  f"{sum(r.get('P3', 0) or 0 for r in bucket) / n:.3f} | "
                  f"{sum(r.get('netExpectedR', 0) or 0 for r in bucket) / n:.4f} |")
        print()

    print("## Interpretation Notes\n")
    print("- Spearman/Pearson magnitudes above ~0.10 with n>100 begin to be interesting; above ~0.20 is material.")
    print("- Decile buckets are post-hoc (data-driven quantiles). A positive bucket must be confirmed on untouched OOS data before it is treated as validated.")
    print("- Conditional pockets from the fixed hypothesis list are pre-specified, but still require OOS confirmation.")
    print("- Do not treat a pocket as an edge unless its 95% CI of netExpectedR is entirely above zero and the story was specified before peeking at the outcome.")
    print("- If no feature or combination shows a clearly positive netExpectedR with a tight CI, the current feature set likely lacks predictive information for this execution model.")


if __name__ == "__main__":
    main()
