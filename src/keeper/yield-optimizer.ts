import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

/**
 * Yield Optimizer — Maximize idle capital returns during inactive periods.
 *
 * Arashi is idle 34% of the time (extreme vol regime). At a fixed 3% lending APY,
 * that's ~1% annual contribution. By routing to the highest-yield lending protocol,
 * we can capture 5-7% on idle capital instead of 1.5-3%.
 *
 * Production strategy:
 * 1. During normal/high regimes → capital in perp positions (funding harvesting)
 * 2. During extreme regime → capital routed to best lending protocol
 * 3. Non-positioned capital always earning lending yield
 *
 * Additionally, capital in perp positions can earn lending yield on collateral
 * by using LST (jitoSOL) as collateral instead of plain SOL.
 */

export interface LendingOption {
  protocol: string;
  asset: string;
  apy: number;
  available: boolean;
  minDeposit: number;
}

/**
 * Fetch best available lending rates across Solana protocols.
 * In production, this queries each protocol's API.
 */
export async function fetchBestLendingOptions(): Promise<LendingOption[]> {
  const options: LendingOption[] = [];

  // Drift lending rate
  try {
    const res = await fetch(`${DRIFT_DATA_API}/stats/USDC/rateHistory/deposit`);
    if (res.ok) {
      const body = (await res.json()) as {
        success: boolean;
        records: Array<{ depositRate: string }>;
      };
      if (body.success && body.records?.length > 0) {
        options.push({
          protocol: "Drift Earn",
          asset: "USDC",
          apy: parseFloat(body.records[0].depositRate) * 100,
          available: true,
          minDeposit: 100,
        });
      }
    }
  } catch {}

  // Known protocol rates (in production, fetch via each protocol's API)
  options.push(
    { protocol: "Kamino Lend", asset: "USDC", apy: 6.5, available: true, minDeposit: 100 },
    { protocol: "Marginfi", asset: "USDC", apy: 5.0, available: true, minDeposit: 100 },
    { protocol: "Save (Solend)", asset: "USDC", apy: 4.0, available: true, minDeposit: 100 }
  );

  return options.sort((a, b) => b.apy - a.apy);
}

/**
 * Get the best lending option for idle capital.
 */
export async function getBestLendingRate(): Promise<LendingOption> {
  const options = await fetchBestLendingOptions();
  return options[0] ?? { protocol: "Drift Earn", asset: "USDC", apy: 3.0, available: true, minDeposit: 100 };
}

/**
 * Compute yield breakdown for Arashi.
 */
export interface ArashiYieldBreakdown {
  fundingYieldAPY: number;
  lendingIdleAPY: number;
  lstCollateralAPY: number;
  makerRebateAPY: number;
  totalAPY: number;
  activeTimePct: number;
  idleTimePct: number;
}

export function computeArashiYield(
  annualizedFundingBps: number,
  positionSizePct: number,
  leverage: number,
  activeTimePct: number,
  bestLendingAPY: number
): ArashiYieldBreakdown {
  const idleTimePct = 100 - activeTimePct;

  // Funding yield: position size × funding × leverage × active time
  const fundingYieldAPY =
    (positionSizePct / 100) * (annualizedFundingBps / 100) * leverage * (activeTimePct / 100);

  // Lending on idle: full capital × lending rate × idle time
  const lendingIdleAPY = bestLendingAPY * (idleTimePct / 100);

  // LST yield: if enabled, earn staking on SOL collateral
  // For USDC vault: swap partial → SOL → jitoSOL → collateral → hedge
  // Net after hedge: ~5% on 30% of active capital
  const lstCollateralAPY = STRATEGY_CONFIG.enableLstYield
    ? 5.0 * 0.3 * (positionSizePct / 100) * (activeTimePct / 100)
    : 0;

  const makerRebateAPY = 0.04;

  const totalAPY = fundingYieldAPY + lendingIdleAPY + lstCollateralAPY + makerRebateAPY;

  return {
    fundingYieldAPY,
    lendingIdleAPY,
    lstCollateralAPY,
    makerRebateAPY,
    totalAPY,
    activeTimePct,
    idleTimePct,
  };
}

export function logArashiYield(breakdown: ArashiYieldBreakdown): void {
  console.log("\n--- Yield Breakdown (Estimated) ---");
  console.log(`  Active time:            ${breakdown.activeTimePct.toFixed(0)}% (earning funding)`);
  console.log(`  Idle time:              ${breakdown.idleTimePct.toFixed(0)}% (earning lending)`);
  console.log(`  ────────────────────────────────`);
  console.log(`  Funding (bidir.):       ${breakdown.fundingYieldAPY.toFixed(2)}% APY`);
  console.log(`  Lending (idle):         ${breakdown.lendingIdleAPY.toFixed(2)}% APY`);
  console.log(`  LST collateral:         ${breakdown.lstCollateralAPY.toFixed(2)}% APY`);
  console.log(`  Maker rebates:          ${breakdown.makerRebateAPY.toFixed(2)}% APY`);
  console.log(`  ────────────────────────────────`);
  console.log(`  Total estimated:        ${breakdown.totalAPY.toFixed(2)}% APY`);
}
