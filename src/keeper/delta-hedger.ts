import {
  DriftClient,
  PositionDirection,
  OrderType,
  MarketType,
  BN,
} from "@drift-labs/sdk";
import { BASE_PRECISION, PRICE_PRECISION } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";
import { VolRegime } from "./regime-detector";

export interface PortfolioDelta {
  netDeltaUsd: number;
  deltaByMarket: Map<number, number>;
  totalNotional: number;
  deltaPct: number;
}

/**
 * Compute portfolio delta across all perp positions
 */
export function computePortfolioDelta(
  driftClient: DriftClient
): PortfolioDelta {
  const user = driftClient.getUser();
  const perpPositions = user.getActivePerpPositions();

  let netDeltaUsd = 0;
  let totalNotional = 0;
  const deltaByMarket = new Map<number, number>();

  for (const pos of perpPositions) {
    const oracle = driftClient.getOracleDataForPerpMarket(pos.marketIndex);
    const price = oracle.price.toNumber() / PRICE_PRECISION;
    const size = pos.baseAssetAmount.toNumber() / BASE_PRECISION;
    const deltaUsd = size * price;

    netDeltaUsd += deltaUsd;
    totalNotional += Math.abs(deltaUsd);
    deltaByMarket.set(pos.marketIndex, deltaUsd);
  }

  return {
    netDeltaUsd,
    deltaByMarket,
    totalNotional,
    deltaPct:
      totalNotional > 0
        ? (Math.abs(netDeltaUsd) / totalNotional) * 100
        : 0,
  };
}

/**
 * Get the dynamic delta threshold for the current regime.
 *
 * Addresses the critique: "±5% delta is too loose. For a strategy
 * claiming to harvest volatility, allowing 5% delta exposure is
 * effectively a directional gamble in disguise."
 *
 * Now: 5% in veryLow → 0.5% in extreme (tightens with vol)
 */
export function getDeltaThreshold(regime: VolRegime): number {
  const thresholds = STRATEGY_CONFIG.maxDeltaPctByRegime;
  return thresholds[regime] ?? 2;
}

/**
 * Determine if a delta hedge is needed using regime-aware threshold
 */
export function needsHedge(
  delta: PortfolioDelta,
  regime: VolRegime
): {
  hedge: boolean;
  hedgeSizeUsd: number;
  direction: "long" | "short";
  threshold: number;
} {
  const threshold = getDeltaThreshold(regime);

  if (delta.deltaPct <= threshold) {
    return { hedge: false, hedgeSizeUsd: 0, direction: "long", threshold };
  }

  const hedgeSizeUsd = Math.abs(delta.netDeltaUsd);
  const direction: "long" | "short" =
    delta.netDeltaUsd > 0 ? "short" : "long";

  return { hedge: true, hedgeSizeUsd, direction, threshold };
}

/**
 * Execute a delta hedge on the primary hedge market
 */
export async function executeDeltaHedge(
  driftClient: DriftClient,
  hedgeSizeUsd: number,
  direction: "long" | "short"
): Promise<string> {
  const { hedgeMarket } = STRATEGY_CONFIG;

  const oracle = driftClient.getOracleDataForPerpMarket(hedgeMarket);
  const price = oracle.price.toNumber() / PRICE_PRECISION;
  const baseAmount = (hedgeSizeUsd / price) * BASE_PRECISION;

  const orderParams = {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex: hedgeMarket,
    direction:
      direction === "long"
        ? PositionDirection.LONG
        : PositionDirection.SHORT,
    baseAssetAmount: new BN(Math.floor(baseAmount)),
    reduceOnly: false,
  };

  const txSig = await driftClient.placePerpOrder(orderParams);
  console.log(
    `Delta hedge: ${direction} $${hedgeSizeUsd.toFixed(2)} on market ${hedgeMarket} (threshold: regime-based) | tx: ${txSig}`
  );
  return txSig;
}
