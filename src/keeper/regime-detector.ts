import { STRATEGY_CONFIG } from "../config/vault";
import { VolState } from "./vol-engine";

export type VolRegime = "veryLow" | "low" | "normal" | "high" | "extreme";

export interface RegimeState {
  regime: VolRegime;
  positionSizePct: number;
  confidence: number; // 0-1, how confident we are in the regime classification
  signals: string[];
  lastTransition: number;
  transitionCount: number;
}

export function classifyRegime(volBps: number): VolRegime {
  const t = STRATEGY_CONFIG.regimeThresholds;
  if (volBps < t.veryLow) return "veryLow";
  if (volBps < t.low) return "low";
  if (volBps < t.normal) return "normal";
  if (volBps < t.high) return "high";
  return "extreme";
}

export function detectRegime(
  volStates: Map<string, VolState>,
  prevRegime?: RegimeState
): RegimeState {
  const signals: string[] = [];
  const regimes: VolRegime[] = [];

  for (const [market, vol] of volStates) {
    const regime = classifyRegime(vol.realizedVolBps);
    regimes.push(regime);

    if (vol.isElevated) {
      signals.push(`${market}: vol elevated (${(vol.realizedVol * 100).toFixed(1)}% vs ${(vol.emaVol30d * 100).toFixed(1)}% ema30d)`);
    }
    if (vol.isDepressed) {
      signals.push(`${market}: vol depressed (${(vol.realizedVol * 100).toFixed(1)}% vs ${(vol.emaVol30d * 100).toFixed(1)}% ema30d)`);
    }
  }

  // Aggregate regime: use the highest regime across all markets (conservative)
  const regimeOrder: VolRegime[] = [
    "veryLow",
    "low",
    "normal",
    "high",
    "extreme",
  ];
  const maxRegimeIdx = Math.max(
    ...regimes.map((r) => regimeOrder.indexOf(r))
  );
  const aggregateRegime = regimeOrder[maxRegimeIdx] ?? "normal";

  // Confidence: how many markets agree on the regime
  const agreeing = regimes.filter((r) => r === aggregateRegime).length;
  const confidence = agreeing / Math.max(regimes.length, 1);

  // Detect regime transition
  const isTransition =
    prevRegime !== undefined && prevRegime.regime !== aggregateRegime;
  if (isTransition) {
    signals.push(
      `Regime transition: ${prevRegime!.regime} -> ${aggregateRegime}`
    );
  }

  const positionSizePct =
    STRATEGY_CONFIG.regimeSizing[aggregateRegime];

  return {
    regime: aggregateRegime,
    positionSizePct,
    confidence,
    signals,
    lastTransition: isTransition ? Date.now() : (prevRegime?.lastTransition ?? Date.now()),
    transitionCount: (prevRegime?.transitionCount ?? 0) + (isTransition ? 1 : 0),
  };
}

export function shouldPauseTrading(regime: RegimeState): {
  pause: boolean;
  reason: string;
} {
  // Pause in extreme vol
  if (regime.regime === "extreme") {
    return { pause: true, reason: "Extreme volatility regime — pausing new positions" };
  }

  // Pause if regime is transitioning rapidly (>3 transitions in last hour)
  if (regime.transitionCount > 3) {
    return {
      pause: true,
      reason: "Rapid regime transitions — market unstable",
    };
  }

  return { pause: false, reason: "" };
}
