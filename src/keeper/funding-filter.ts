import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";
import { FundingDirection } from "./vol-trader";

export interface MarketFundingState {
  market: string;
  fundingRate: number; // Per-hour rate (normalized)
  annualizedPct: number;
  isPositive: boolean;
  direction: FundingDirection; // Which side earns
  magnitude: number; // Absolute annualized %
}

/**
 * Bidirectional Funding Analysis (v3)
 *
 * Previous versions blocked entry when funding was negative.
 * v3 recognizes that negative funding = opportunity for LONGS.
 *
 * - Positive funding → shorts earn → direction = "short"
 * - Negative funding → longs earn → direction = "long"
 *
 * The only case we block is when |funding| is too small to
 * cover trading costs (the cost gate still applies).
 */
export async function fetchMarketFunding(
  market: string
): Promise<MarketFundingState> {
  const res = await fetch(`${DRIFT_DATA_API}/stats/fundingRates`);
  if (!res.ok) {
    throw new Error(`Failed to fetch funding rates: ${res.status}`);
  }

  const body = (await res.json()) as {
    success: boolean;
    markets: Array<{
      marketIndex: number;
      symbol: string;
      fundingRates: { "24h": string; "7d": string };
    }>;
  };

  const entry = body.markets.find((m) => m.symbol === market);
  if (!entry) {
    return {
      market,
      fundingRate: 0,
      annualizedPct: 0,
      isPositive: false,
      direction: "short",
      magnitude: 0,
    };
  }

  const rate24h = parseFloat(entry.fundingRates["24h"]);
  const annualized = rate24h * 24 * 365 * 100;

  return {
    market,
    fundingRate: rate24h,
    annualizedPct: annualized,
    isPositive: rate24h > 0,
    direction: rate24h >= 0 ? "short" : "long",
    magnitude: Math.abs(annualized),
  };
}

/**
 * Check if a market's funding rate is worth trading (either direction).
 *
 * v3: No longer blocks negative funding — instead determines direction.
 * Only blocks when |funding| is too small to cover costs.
 */
export function passesFundingGate(funding: MarketFundingState): {
  pass: boolean;
  direction: FundingDirection;
  reason: string;
} {
  // Magnitude gate: |funding| must be above minimum threshold
  if (Math.abs(funding.fundingRate) < STRATEGY_CONFIG.minFundingRateToEnter) {
    return {
      pass: false,
      direction: funding.direction,
      reason: `|Funding| too low (${(Math.abs(funding.fundingRate) * 100).toFixed(4)}%) — below minimum threshold`,
    };
  }

  // Cost gate: expected |funding| must exceed round-trip costs
  const { estimatedSlippageBps, driftMakerFeeBps, useLimitOrders, driftTakerFeeBps, minHoldingPeriodHours } =
    STRATEGY_CONFIG;
  const perTradeCost = useLimitOrders
    ? Math.max(0, estimatedSlippageBps + driftMakerFeeBps)
    : estimatedSlippageBps + driftTakerFeeBps;
  const roundTripCostBps = 2 * perTradeCost;
  const expectedFundingBps =
    (funding.magnitude * 100 * minHoldingPeriodHours) / 8760;

  if (expectedFundingBps < roundTripCostBps) {
    return {
      pass: false,
      direction: funding.direction,
      reason: `|Funding| (${expectedFundingBps.toFixed(1)} bps/${minHoldingPeriodHours}h) < costs (${roundTripCostBps.toFixed(1)} bps)`,
    };
  }

  const dirLabel = funding.direction === "short" ? "SHORT (longs pay)" : "LONG (shorts pay)";
  return {
    pass: true,
    direction: funding.direction,
    reason: `${dirLabel} — ${funding.magnitude.toFixed(1)}% APY`,
  };
}
