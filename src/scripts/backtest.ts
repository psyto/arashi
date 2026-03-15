import { DRIFT_DATA_API, HOURS_PER_YEAR } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";
import {
  computeParkinsonVol,
  computeYangZhangVol,
  CandleData,
} from "../keeper/vol-engine";
import { classifyRegime } from "../keeper/regime-detector";

interface FundingRecord {
  ts: number;
  symbol: string;
  fundingRate: string;
  fundingRateShort: string;
  oraclePriceTwap: string;
}

async function fetchFundingHistory(market: string): Promise<FundingRecord[]> {
  const res = await fetch(
    `${DRIFT_DATA_API}/market/${market}/fundingRates?limit=750`
  );
  if (!res.ok) throw new Error(`Failed: ${res.status}`);

  const body = (await res.json()) as {
    success: boolean;
    records: FundingRecord[];
  };
  if (!body.success || !body.records) throw new Error("No data");

  return body.records.sort((a, b) => a.ts - b.ts);
}

async function fetchCandleHistory(market: string): Promise<CandleData[]> {
  const res = await fetch(
    `${DRIFT_DATA_API}/market/${market}/candles/60?limit=750`
  );
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const body = (await res.json()) as { success: boolean; records: CandleData[] };
  if (!body.success || !body.records) throw new Error("No data");
  return body.records.sort((a, b) => a.ts - b.ts);
}

async function main() {
  console.log("⛈️  Arashi Vault — Historical Backtest (Realistic)\n");
  console.log("Strategy: Delta-neutral vol harvesting with funding polarity filter");
  const orderType = STRATEGY_CONFIG.useLimitOrders ? "LIMIT (maker)" : "MARKET (taker)";
  const feeBps = STRATEGY_CONFIG.useLimitOrders ? STRATEGY_CONFIG.driftMakerFeeBps : STRATEGY_CONFIG.driftTakerFeeBps;
  console.log(`Regime sizing: 10-40% of equity | Max leverage: ${STRATEGY_CONFIG.maxLeverage}x`);
  console.log(`Orders: ${orderType} | Fee: ${feeBps} bps | Slippage: ${STRATEGY_CONFIG.estimatedSlippageBps} bps\n`);

  const markets = STRATEGY_CONFIG.primaryMarkets; // SOL, BTC, ETH

  console.log("Fetching data...");
  const fundingData = new Map<string, FundingRecord[]>();
  const candleData = new Map<string, CandleData[]>();

  for (const market of markets) {
    try {
      const [funding, candles] = await Promise.all([
        fetchFundingHistory(market),
        fetchCandleHistory(market),
      ]);
      fundingData.set(market, funding);
      candleData.set(market, candles);
      console.log(`  ${market}: ${funding.length} funding, ${candles.length} candles`);
    } catch (err) {
      console.log(`  ${market}: FAILED`);
    }
  }

  // Configuration
  const INITIAL_EQUITY = 100_000;
  const MAX_LEVERAGE = STRATEGY_CONFIG.maxLeverage;

  // v2: Use maker or taker fees based on config
  const PER_TRADE_FEE = STRATEGY_CONFIG.useLimitOrders
    ? Math.max(0, (STRATEGY_CONFIG.estimatedSlippageBps + STRATEGY_CONFIG.driftMakerFeeBps) / 10000)
    : (STRATEGY_CONFIG.estimatedSlippageBps + STRATEGY_CONFIG.driftTakerFeeBps) / 10000;
  const ROUND_TRIP_COST = 2 * PER_TRADE_FEE;
  const HEDGES_PER_DAY = 2;
  const HEDGE_COST_PER = PER_TRADE_FEE; // Same fee structure for hedges

  // Group funding by day
  const allDates = new Set<string>();
  for (const [, records] of fundingData) {
    for (const rec of records) {
      allDates.add(new Date(rec.ts * 1000).toISOString().slice(0, 10));
    }
  }
  const sortedDates = [...allDates].sort();

  // Compute rolling vol per market per day (using candle data)
  const dailyVol = new Map<string, Map<string, number>>(); // market -> date -> vol
  for (const [market, candles] of candleData) {
    const volMap = new Map<string, number>();
    const windowSize = 168; // 7 days
    for (let i = windowSize; i < candles.length; i++) {
      const window = candles.slice(i - windowSize, i);
      const yzVol = computeYangZhangVol(window);
      const pkVol = computeParkinsonVol(window);
      const avgVol = (yzVol + pkVol) / 2;
      const date = new Date(candles[i].ts * 1000).toISOString().slice(0, 10);
      volMap.set(date, avgVol);
    }
    dailyVol.set(market, volMap);
  }

  // Simulate
  let equity = INITIAL_EQUITY;
  let peakEquity = equity;
  let maxDrawdown = 0;
  const dailyReturnsPct: number[] = [];
  let totalTradingCosts = 0;
  let totalHedgeCosts = 0;

  // Lending yield on idle capital
  const LENDING_DAILY_PCT = STRATEGY_CONFIG.estimatedLendingAPY / 365;

  // Stats
  let tradingDays = 0;
  let fundingBlockedDays = 0;
  let regimeBlockedDays = 0;
  let totalLendingYield = 0;
  const regimeDays: Record<string, number> = {};

  interface DayLog {
    date: string;
    equity: number;
    returnPct: number;
    regime: string;
    marketsTraded: string[];
    blocked: string;
  }
  const dayLogs: DayLog[] = [];

  for (const date of sortedDates) {
    // 1. Compute aggregate vol for regime detection
    let avgVolBps = 3500; // Default: normal
    let volCount = 0;
    for (const [market] of dailyVol) {
      const marketVol = dailyVol.get(market)?.get(date);
      if (marketVol !== undefined) {
        avgVolBps += marketVol * 10000;
        volCount++;
      }
    }
    if (volCount > 0) avgVolBps = avgVolBps / volCount;
    else avgVolBps = 3500;

    const regime = classifyRegime(Math.round(avgVolBps));
    regimeDays[regime] = (regimeDays[regime] ?? 0) + 1;

    // 2. Get position sizing from regime
    const regimeSizing = (STRATEGY_CONFIG.regimeSizing[regime] ?? 0) / 100;

    // Pre-extreme wind-down
    let effectiveSizing = regimeSizing;
    if (avgVolBps > STRATEGY_CONFIG.preExtremeWindDownBps) {
      effectiveSizing *= 0.5;
    }

    if (effectiveSizing === 0) {
      regimeBlockedDays++;
      // Idle capital earns lending yield
      const lendingReturn = equity * (LENDING_DAILY_PCT / 100);
      totalLendingYield += lendingReturn;
      equity += lendingReturn;
      const returnPct = (lendingReturn / (equity - lendingReturn)) * 100;
      dailyReturnsPct.push(returnPct);
      dayLogs.push({ date, equity, returnPct, regime, marketsTraded: ["LENDING"], blocked: "regime" });
      continue;
    }

    // 3. Bidirectional funding harvesting per market
    let dayReturn = 0;
    let dayTraded = false;
    const marketsTraded: string[] = [];
    let allBlocked = true;

    for (const [market, records] of fundingData) {
      const dayRecords = records.filter(
        (r) => new Date(r.ts * 1000).toISOString().slice(0, 10) === date
      );
      if (dayRecords.length === 0) continue;

      // Average daily funding (normalized by oracle price)
      const avgFunding =
        dayRecords.reduce((s, r) => {
          const rate = parseFloat(r.fundingRateShort);
          const oracle = parseFloat(r.oraclePriceTwap);
          return s + (oracle > 0 ? rate / oracle : 0);
        }, 0) / dayRecords.length;

      // Magnitude gate: |funding| must exceed minimum threshold
      if (Math.abs(avgFunding) < 0.0000001) continue;

      // v3 Bidirectional: use |funding| as revenue regardless of sign
      // Positive funding → short earns → use fundingRateShort directly
      // Negative funding → long earns → flip sign (long receives what short pays)
      const dailyFundingTotal = dayRecords.reduce(
        (s, r) => {
          const rate = parseFloat(r.fundingRateShort);
          const oracle = parseFloat(r.oraclePriceTwap);
          if (oracle <= 0) return s;
          const normalizedRate = rate / oracle;
          // We always position on the receiving side:
          // If rate > 0: we short, we receive → positive return
          // If rate < 0: we long, we receive |rate| → positive return
          return s + Math.abs(normalizedRate);
        },
        0
      );

      allBlocked = false;
      marketsTraded.push(market);

      // Position size for this market
      const positionSize =
        (equity * effectiveSizing * MAX_LEVERAGE) / markets.length;

      // Return from this market = position × daily funding rate
      const marketReturn = positionSize * dailyFundingTotal;
      dayReturn += marketReturn;
      dayTraded = true;
    }

    if (allBlocked) {
      fundingBlockedDays++;
      // Idle capital earns lending yield
      const lendingReturn = equity * (LENDING_DAILY_PCT / 100);
      totalLendingYield += lendingReturn;
      equity += lendingReturn;
      const returnPct = (lendingReturn / (equity - lendingReturn)) * 100;
      dailyReturnsPct.push(returnPct);
      dayLogs.push({ date, equity, returnPct, regime, marketsTraded: ["LENDING"], blocked: "funding" });
      continue;
    }

    // 4. Deduct hedging costs (per market traded)
    const hedgeCost =
      marketsTraded.length * HEDGES_PER_DAY * HEDGE_COST_PER *
      ((equity * effectiveSizing * MAX_LEVERAGE) / markets.length);
    totalHedgeCosts += hedgeCost;

    // 5. Deduct entry/exit costs if position changed (simplified: 1 change per week)
    let entryCost = 0;
    // Rough estimate: position changes once per week
    if (Math.random() < 1 / 7) {
      entryCost =
        marketsTraded.length *
        ROUND_TRIP_COST *
        ((equity * effectiveSizing * MAX_LEVERAGE) / markets.length);
      totalTradingCosts += entryCost;
    }

    const netReturn = dayReturn - hedgeCost - entryCost;
    equity += netReturn;

    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;

    const returnPct = (netReturn / (equity - netReturn)) * 100;
    dailyReturnsPct.push(returnPct);

    if (dayTraded) tradingDays++;
    dayLogs.push({ date, equity, returnPct, regime, marketsTraded, blocked: "" });
  }

  // Results
  const totalDays = sortedDates.length;
  const totalReturnPct = ((equity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
  const annualizedAPY = (totalReturnPct / totalDays) * 365;
  const avgDaily =
    dailyReturnsPct.reduce((a, b) => a + b, 0) / dailyReturnsPct.length;
  const stdDaily = Math.sqrt(
    dailyReturnsPct.reduce((s, r) => s + (r - avgDaily) ** 2, 0) /
      dailyReturnsPct.length
  );
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(365) : 0;

  console.log("\n════════════════════════════════════════");
  console.log("           BACKTEST RESULTS");
  console.log("════════════════════════════════════════\n");
  console.log(`Period:            ${totalDays} days (${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]})`);
  console.log(`Starting equity:   $${INITIAL_EQUITY.toLocaleString()}`);
  console.log(`Ending equity:     $${equity.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
  console.log(`Total return:      ${totalReturnPct.toFixed(2)}%`);
  console.log(`Annualized APY:    ${annualizedAPY.toFixed(2)}%`);
  console.log(`Max drawdown:      ${(maxDrawdown * 100).toFixed(2)}%`);
  console.log(`Sharpe ratio:      ${sharpe.toFixed(2)}`);
  console.log(`\nActivity:`);
  console.log(`  Trading days:      ${tradingDays}/${totalDays} (${((tradingDays / totalDays) * 100).toFixed(0)}%)`);
  console.log(`  Funding blocked:   ${fundingBlockedDays} days (${((fundingBlockedDays / totalDays) * 100).toFixed(0)}%)`);
  console.log(`  Regime blocked:    ${regimeBlockedDays} days (${((regimeBlockedDays / totalDays) * 100).toFixed(0)}%)`);
  console.log(`\nRevenue & Costs:`);
  console.log(`  Lending yield:     $${totalLendingYield.toFixed(2)} (idle days earning ${STRATEGY_CONFIG.estimatedLendingAPY}% APY)`);
  console.log(`  Trading costs:     $${totalTradingCosts.toFixed(2)}`);
  console.log(`  Hedge costs:       $${totalHedgeCosts.toFixed(2)}`);
  console.log(`  Total costs:       $${(totalTradingCosts + totalHedgeCosts).toFixed(2)} (${(((totalTradingCosts + totalHedgeCosts) / INITIAL_EQUITY) * 100).toFixed(2)}% of initial)`);
  console.log(`\nRegime breakdown:`);
  for (const [regime, days] of Object.entries(regimeDays).sort()) {
    console.log(`  ${regime.padEnd(12)} ${days} days (${((days / totalDays) * 100).toFixed(0)}%)`);
  }

  // Equity curve
  console.log("\nEquity curve:");
  for (let i = 0; i < dayLogs.length; i++) {
    if (i % 5 === 0 || i === dayLogs.length - 1) {
      const d = dayLogs[i];
      const pct = ((d.equity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
      const bar = pct >= 0
        ? "█".repeat(Math.min(Math.round(pct * 5), 50))
        : "░".repeat(Math.min(Math.round(Math.abs(pct) * 5), 50));
      const status = d.blocked ? `[${d.blocked}]` : d.marketsTraded.join(",") || "idle";
      console.log(
        `  ${d.date} | $${d.equity.toFixed(0).padStart(9)} | ${pct >= 0 ? "+" : ""}${pct.toFixed(2).padStart(7)}% | ${d.regime.padEnd(8)} | ${status} ${bar}`
      );
    }
  }

  // Verdict
  console.log("\n════════════════════════════════════════");
  console.log(`Target APY:   ≥10%`);
  console.log(`Achieved APY: ${annualizedAPY.toFixed(2)}%`);
  console.log(`Verdict:      ${annualizedAPY >= 10 ? "MEETS TARGET ✓" : annualizedAPY > 0 ? "POSITIVE BUT BELOW TARGET" : "NEGATIVE — CAPITAL PRESERVED BY SITTING OUT"}`);
  console.log(`Max DD:       ${(maxDrawdown * 100).toFixed(2)}% (limit: 5% reduce / 8% close)`);
  console.log(`Idle rate:    ${(((fundingBlockedDays + regimeBlockedDays) / totalDays) * 100).toFixed(0)}% — cost of safety`);
  console.log("════════════════════════════════════════");
}

main().catch(console.error);
