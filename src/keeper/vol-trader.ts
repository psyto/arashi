import {
  DriftClient,
  PositionDirection,
  OrderType,
  MarketType,
  BN,
} from "@drift-labs/sdk";
import { BASE_PRECISION, PRICE_PRECISION } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";
import { VolState } from "./vol-engine";
import { RegimeState } from "./regime-detector";

export type FundingDirection = "short" | "long";

export interface VolPosition {
  marketIndex: number;
  marketName: string;
  direction: FundingDirection;
  sizeUsd: number;
  netDelta: number;
  entryVol: number;
  entryFundingRate: number;
  entryTimestamp: number;
}

/**
 * Bidirectional Funding Harvester (v3)
 *
 * Previous versions only shorted perps (collect funding when positive).
 * This fails in bear markets where funding is negative (shorts pay longs).
 *
 * v3 insight: funding flows BOTH ways.
 * - Positive funding → SHORT perps (longs pay shorts)
 * - Negative funding → LONG perps (shorts pay longs)
 *
 * Arashi now earns yield regardless of market direction by always
 * positioning on the receiving side of funding.
 *
 * Delta is still managed by the delta-hedger module — the hedge
 * offsets the directional exposure from the funding position.
 */
export function determineFundingDirection(
  hourlyFundingRate: number
): { direction: FundingDirection; reason: string } {
  if (hourlyFundingRate > 0) {
    return {
      direction: "short",
      reason: `Positive funding (${(hourlyFundingRate * 100).toFixed(4)}%) → SHORT to collect`,
    };
  } else if (hourlyFundingRate < 0) {
    return {
      direction: "long",
      reason: `Negative funding (${(hourlyFundingRate * 100).toFixed(4)}%) → LONG to collect`,
    };
  }
  return { direction: "short", reason: "Zero funding — defaulting to short" };
}

export function computeVolTradeSize(
  totalEquity: number,
  regime: RegimeState,
  volState: VolState,
  marketIndex: number
): { sizeUsd: number; skip: boolean; reason: string } {
  const { maxLeverage, maxVegaExposurePct } = STRATEGY_CONFIG;

  const regimePct = regime.positionSizePct;
  if (regimePct === 0) {
    return { sizeUsd: 0, skip: true, reason: "Regime says zero sizing" };
  }

  const perMarketPct =
    regimePct / STRATEGY_CONFIG.primaryMarkets.length;
  let sizeUsd = (totalEquity * perMarketPct) / 100;

  const maxSizeByLeverage = totalEquity * maxLeverage;
  sizeUsd = Math.min(sizeUsd, maxSizeByLeverage);

  const vegaLimit = (totalEquity * maxVegaExposurePct) / 100;
  sizeUsd = Math.min(sizeUsd, vegaLimit);

  return { sizeUsd, skip: false, reason: "" };
}

/**
 * Open a funding position in the direction that EARNS funding.
 * SHORT when funding positive, LONG when funding negative.
 * Uses LIMIT orders (maker) for fee rebates.
 */
export async function openVolPosition(
  driftClient: DriftClient,
  marketIndex: number,
  sizeUsd: number,
  direction: FundingDirection = "short"
): Promise<string> {
  const oracle = driftClient.getOracleDataForPerpMarket(marketIndex);
  const price = oracle.price.toNumber() / PRICE_PRECISION;
  const baseAmount = (sizeUsd / price) * BASE_PRECISION;

  const perpDirection =
    direction === "short" ? PositionDirection.SHORT : PositionDirection.LONG;

  if (STRATEGY_CONFIG.useLimitOrders) {
    // For SHORT: place above oracle (willing to sell higher)
    // For LONG: place below oracle (willing to buy lower)
    const spreadSign = direction === "short" ? 1 : -1;
    const spreadMultiplier =
      1 + spreadSign * (STRATEGY_CONFIG.limitOrderSpreadBps / 10000);
    const limitPrice = Math.floor(price * spreadMultiplier * PRICE_PRECISION);

    const orderParams = {
      orderType: OrderType.LIMIT,
      marketType: MarketType.PERP,
      marketIndex,
      direction: perpDirection,
      baseAssetAmount: new BN(Math.floor(baseAmount)),
      price: new BN(limitPrice),
      reduceOnly: false,
      postOnly: true,
    };

    const txSig = await driftClient.placePerpOrder(orderParams);
    console.log(
      `Vol trade: ${direction.toUpperCase()} LIMIT $${sizeUsd.toFixed(2)} on market ${marketIndex} @ $${(limitPrice / PRICE_PRECISION).toFixed(2)} (maker) | tx: ${txSig}`
    );
    return txSig;
  }

  // Fallback: market order
  const orderParams = {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex,
    direction: perpDirection,
    baseAssetAmount: new BN(Math.floor(baseAmount)),
    reduceOnly: false,
  };

  const txSig = await driftClient.placePerpOrder(orderParams);
  console.log(
    `Vol trade: ${direction.toUpperCase()} MARKET $${sizeUsd.toFixed(2)} on market ${marketIndex} (taker) | tx: ${txSig}`
  );
  return txSig;
}

/**
 * Close a vol position — unwind in the opposite direction.
 */
export async function closeVolPosition(
  driftClient: DriftClient,
  marketIndex: number
): Promise<string> {
  const user = driftClient.getUser();
  const position = user.getPerpPosition(marketIndex);
  if (!position || position.baseAssetAmount.isZero()) {
    return "";
  }

  // Determine close direction: opposite of current position
  const isLong = position.baseAssetAmount.gt(new BN(0));
  const closeDirection = isLong
    ? PositionDirection.SHORT
    : PositionDirection.LONG;

  if (STRATEGY_CONFIG.useLimitOrders) {
    const oracle = driftClient.getOracleDataForPerpMarket(marketIndex);
    const price = oracle.price.toNumber() / PRICE_PRECISION;
    // Close long → sell (place above), close short → buy (place below)
    const spreadSign = isLong ? 1 : -1;
    const spreadMultiplier =
      1 + spreadSign * (STRATEGY_CONFIG.limitOrderSpreadBps / 10000);
    const limitPrice = Math.floor(price * spreadMultiplier * PRICE_PRECISION);

    const orderParams = {
      orderType: OrderType.LIMIT,
      marketType: MarketType.PERP,
      marketIndex,
      direction: closeDirection,
      baseAssetAmount: position.baseAssetAmount.abs(),
      price: new BN(limitPrice),
      reduceOnly: true,
      postOnly: true,
    };

    const txSig = await driftClient.placePerpOrder(orderParams);
    console.log(
      `Close LIMIT on market ${marketIndex} (maker) | tx: ${txSig}`
    );
    return txSig;
  }

  const orderParams = {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex,
    direction: closeDirection,
    baseAssetAmount: position.baseAssetAmount.abs(),
    reduceOnly: true,
  };

  const txSig = await driftClient.placePerpOrder(orderParams);
  console.log(`Close MARKET on market ${marketIndex} (taker) | tx: ${txSig}`);
  return txSig;
}
