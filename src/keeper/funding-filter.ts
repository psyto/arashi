import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

export interface MarketFundingState {
  market: string;
  fundingRate: number; // Per-hour rate
  annualizedPct: number;
  isPositive: boolean;
}

/**
 * Funding polarity filter.
 *
 * Addresses the critical review finding:
 * "If the core of the strategy is harvesting funding, the primary condition
 *  should be Funding Rate > 0, not just the volatility coefficient."
 *
 * Even if vol is high and the regime says "enter," we MUST NOT enter
 * when funding is negative — that means we'd be PAYING, not earning.
 * In panic-driven bear markets, funding often turns deeply negative
 * (shorts pay longs), and high vol would incorrectly signal opportunity.
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
    return { market, fundingRate: 0, annualizedPct: 0, isPositive: false };
  }

  const rate24h = parseFloat(entry.fundingRates["24h"]);
  return {
    market,
    fundingRate: rate24h,
    annualizedPct: rate24h * 24 * 365 * 100,
    isPositive: rate24h > 0,
  };
}

/**
 * Check if a market passes the funding polarity gate.
 * Returns false if:
 * 1. Funding is negative (hard gate)
 * 2. Funding is positive but below the cost threshold
 */
export function passesFundingGate(funding: MarketFundingState): {
  pass: boolean;
  reason: string;
} {
  // Hard gate: funding must be positive
  if (STRATEGY_CONFIG.fundingMustBePositive && !funding.isPositive) {
    return {
      pass: false,
      reason: `Funding negative (${(funding.fundingRate * 100).toFixed(4)}%) — would pay, not earn`,
    };
  }

  // Minimum rate gate
  if (funding.fundingRate < STRATEGY_CONFIG.minFundingRateToEnter) {
    return {
      pass: false,
      reason: `Funding too low (${(funding.fundingRate * 100).toFixed(4)}%) — below minimum threshold`,
    };
  }

  // Cost gate: expected funding must exceed round-trip costs
  const { driftTakerFeeBps, estimatedSlippageBps, minHoldingPeriodHours } =
    STRATEGY_CONFIG;
  const roundTripCostBps = 2 * (driftTakerFeeBps + estimatedSlippageBps);
  const expectedFundingBps =
    (funding.annualizedPct * 100 * minHoldingPeriodHours) / 8760;

  if (expectedFundingBps < roundTripCostBps) {
    return {
      pass: false,
      reason: `Funding (${expectedFundingBps.toFixed(1)} bps/${minHoldingPeriodHours}h) < costs (${roundTripCostBps.toFixed(1)} bps round-trip)`,
    };
  }

  return { pass: true, reason: "Funding positive and cost-viable" };
}
