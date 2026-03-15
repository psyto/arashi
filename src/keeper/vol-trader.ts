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

export interface VolPosition {
  marketIndex: number;
  marketName: string;
  longSize: number; // In base asset
  shortSize: number; // In base asset
  netDelta: number; // USD
  entryVol: number;
  entryTimestamp: number;
}

/**
 * Approximate vol selling via "synthetic short straddle" on Drift perps:
 *
 * A short straddle profits when price stays near strike and loses on big moves.
 * We approximate this by:
 * 1. Entering a short perp position (captures funding when positive)
 * 2. Setting tight stop losses on both sides (limits gamma exposure)
 * 3. Collecting the funding rate as "vol premium"
 *
 * The key insight: in high-vol regimes, funding rates tend to be higher
 * (longs pay more to maintain leveraged positions), so short perp positions
 * collect more premium — effectively "selling volatility."
 *
 * Delta is managed separately by the delta-hedger module.
 */
export function computeVolTradeSize(
  totalEquity: number,
  regime: RegimeState,
  volState: VolState,
  marketIndex: number
): { sizeUsd: number; skip: boolean; reason: string } {
  const { maxLeverage, maxVegaExposurePct } = STRATEGY_CONFIG;

  // Position size based on regime
  const regimePct = regime.positionSizePct;
  if (regimePct === 0) {
    return { sizeUsd: 0, skip: true, reason: "Regime says zero sizing" };
  }

  // Base allocation for this market
  const perMarketPct =
    regimePct / STRATEGY_CONFIG.primaryMarkets.length;
  let sizeUsd = (totalEquity * perMarketPct) / 100;

  // Cap by leverage
  const maxSizeByLeverage = totalEquity * maxLeverage;
  sizeUsd = Math.min(sizeUsd, maxSizeByLeverage);

  // Cap by vega exposure
  // Rough vega approximation: position_size * sqrt(T) * vol_sensitivity
  // For short-dated positions, limit total vega to maxVegaExposurePct of equity
  const vegaLimit = (totalEquity * maxVegaExposurePct) / 100;
  sizeUsd = Math.min(sizeUsd, vegaLimit);

  return { sizeUsd, skip: false, reason: "" };
}

/**
 * Open a vol-selling position on a market.
 * This is a short perp that collects funding.
 * Delta is hedged separately.
 */
/**
 * Open a vol-selling position using LIMIT orders (maker) when possible.
 * Maker rebate: -0.002% vs Taker: 0.035% — transforms cost to income.
 */
export async function openVolPosition(
  driftClient: DriftClient,
  marketIndex: number,
  sizeUsd: number
): Promise<string> {
  const oracle = driftClient.getOracleDataForPerpMarket(marketIndex);
  const price = oracle.price.toNumber() / PRICE_PRECISION;
  const baseAmount = (sizeUsd / price) * BASE_PRECISION;

  if (STRATEGY_CONFIG.useLimitOrders) {
    const spreadMultiplier = 1 + STRATEGY_CONFIG.limitOrderSpreadBps / 10000;
    const limitPrice = Math.floor(price * spreadMultiplier * PRICE_PRECISION);

    const orderParams = {
      orderType: OrderType.LIMIT,
      marketType: MarketType.PERP,
      marketIndex,
      direction: PositionDirection.SHORT,
      baseAssetAmount: new BN(Math.floor(baseAmount)),
      price: new BN(limitPrice),
      reduceOnly: false,
      postOnly: true,
    };

    const txSig = await driftClient.placePerpOrder(orderParams);
    console.log(
      `Vol trade: SHORT LIMIT $${sizeUsd.toFixed(2)} on market ${marketIndex} @ $${(limitPrice / PRICE_PRECISION).toFixed(2)} (maker) | tx: ${txSig}`
    );
    return txSig;
  }

  const orderParams = {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex,
    direction: PositionDirection.SHORT,
    baseAssetAmount: new BN(Math.floor(baseAmount)),
    reduceOnly: false,
  };

  const txSig = await driftClient.placePerpOrder(orderParams);
  console.log(
    `Vol trade: SHORT MARKET $${sizeUsd.toFixed(2)} on market ${marketIndex} (taker) | tx: ${txSig}`
  );
  return txSig;
}

/**
 * Close a vol position — unwind the short
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

  if (STRATEGY_CONFIG.useLimitOrders) {
    const oracle = driftClient.getOracleDataForPerpMarket(marketIndex);
    const price = oracle.price.toNumber() / PRICE_PRECISION;
    const spreadMultiplier = 1 - STRATEGY_CONFIG.limitOrderSpreadBps / 10000;
    const limitPrice = Math.floor(price * spreadMultiplier * PRICE_PRECISION);

    const orderParams = {
      orderType: OrderType.LIMIT,
      marketType: MarketType.PERP,
      marketIndex,
      direction: PositionDirection.LONG,
      baseAssetAmount: position.baseAssetAmount.abs(),
      price: new BN(limitPrice),
      reduceOnly: true,
      postOnly: true,
    };

    const txSig = await driftClient.placePerpOrder(orderParams);
    console.log(`Close LIMIT on market ${marketIndex} (maker) | tx: ${txSig}`);
    return txSig;
  }

  const orderParams = {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex,
    direction: PositionDirection.LONG,
    baseAssetAmount: position.baseAssetAmount.abs(),
    reduceOnly: true,
  };

  const txSig = await driftClient.placePerpOrder(orderParams);
  console.log(`Close MARKET on market ${marketIndex} (taker) | tx: ${txSig}`);
  return txSig;
}
