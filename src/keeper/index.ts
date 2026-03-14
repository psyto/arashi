import { Connection, Keypair } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
} from "@drift-labs/sdk";
import { getConnection, loadKeypair, sleep } from "../utils/helpers";
import { STRATEGY_CONFIG } from "../config/vault";
import { DRIFT_PROGRAM_ID, DRIFT_PERP_MARKETS } from "../config/constants";
import { computeVolState, VolState } from "./vol-engine";
import {
  detectRegime,
  shouldPauseTrading,
  RegimeState,
} from "./regime-detector";
import {
  computePortfolioDelta,
  needsHedge,
  executeDeltaHedge,
} from "./delta-hedger";
import {
  computeVolTradeSize,
  openVolPosition,
  closeVolPosition,
} from "./vol-trader";
import {
  fetchMarketFunding,
  passesFundingGate,
  MarketFundingState,
} from "./funding-filter";
import { computeHealthState, computeDrawdown } from "./health-monitor";

// State
const volStates = new Map<string, VolState>();
const fundingStates = new Map<string, MarketFundingState>();
let currentRegime: RegimeState | undefined;
const activeMarkets = new Set<number>();
let peakEquity = 0;

async function initDriftClient(
  connection: Connection,
  keypair: Keypair
): Promise<DriftClient> {
  const wallet = new Wallet(keypair);
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 5000);

  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: DRIFT_PROGRAM_ID,
    accountSubscription: {
      type: "polling",
      accountLoader,
    },
  });

  await driftClient.subscribe();
  return driftClient;
}

async function runEmergencyChecks(driftClient: DriftClient): Promise<boolean> {
  // Health ratio check
  const health = computeHealthState(driftClient);
  if (health.action !== "none") {
    console.log(
      `HEALTH ${health.status.toUpperCase()}: ratio=${health.healthRatio.toFixed(3)} pnl=$${health.unrealizedPnl.toFixed(2)}`
    );

    if (health.action === "close_all") {
      console.log("EMERGENCY: Closing all positions — health critical");
      for (const marketIndex of activeMarkets) {
        await closeVolPosition(driftClient, marketIndex);
      }
      activeMarkets.clear();
      return true;
    }

    if (health.action === "reduce") {
      console.log("WARNING: Reducing positions — health declining");
      const first = activeMarkets.values().next().value;
      if (first !== undefined) {
        await closeVolPosition(driftClient, first);
        activeMarkets.delete(first);
      }
    }
  }

  // Drawdown check
  const equity = driftClient.getUser().getTotalCollateral().toNumber() / 1e6;
  if (equity > peakEquity) peakEquity = equity;

  const drawdown = computeDrawdown(equity, peakEquity);
  if (drawdown.action !== "none") {
    console.log(
      `DRAWDOWN ${drawdown.drawdownPct.toFixed(2)}%: equity=$${equity.toFixed(2)} peak=$${peakEquity.toFixed(2)}`
    );

    if (drawdown.action === "close_all") {
      console.log("EMERGENCY: Closing all — severe drawdown");
      for (const marketIndex of activeMarkets) {
        await closeVolPosition(driftClient, marketIndex);
      }
      activeMarkets.clear();
      return true;
    }

    if (drawdown.action === "reduce") {
      const first = activeMarkets.values().next().value;
      if (first !== undefined) {
        await closeVolPosition(driftClient, first);
        activeMarkets.delete(first);
      }
    }
  }

  return false;
}

async function updateVolatility(): Promise<void> {
  console.log("\n--- Volatility Update ---");

  for (const market of STRATEGY_CONFIG.primaryMarkets) {
    try {
      const prevState = volStates.get(market);
      const newState = await computeVolState(market, prevState);
      volStates.set(market, newState);

      console.log(
        `  ${market}: realized=${(newState.realizedVol * 100).toFixed(1)}% ` +
          `ema7d=${(newState.emaVol7d * 100).toFixed(1)}% ` +
          `ema30d=${(newState.emaVol30d * 100).toFixed(1)}% ` +
          `${newState.isElevated ? "[ELEVATED]" : ""}` +
          `${newState.isDepressed ? "[DEPRESSED]" : ""}`
      );
    } catch (err) {
      console.error(`  Failed to compute vol for ${market}:`, err);
    }
  }
}

async function updateFunding(): Promise<void> {
  console.log("\n--- Funding Polarity Check ---");

  for (const market of STRATEGY_CONFIG.primaryMarkets) {
    try {
      const funding = await fetchMarketFunding(market);
      fundingStates.set(market, funding);

      const gate = passesFundingGate(funding);
      const symbol = gate.pass ? "✓" : "✗";
      console.log(
        `  ${symbol} ${market}: ${funding.annualizedPct.toFixed(2)}% APY (${gate.pass ? "PASS" : gate.reason})`
      );
    } catch (err) {
      console.error(`  Failed to fetch funding for ${market}:`, err);
    }
  }
}

async function updateRegime(): Promise<void> {
  if (volStates.size === 0) return;

  const prevRegime = currentRegime;
  currentRegime = detectRegime(volStates, prevRegime);

  const deltaThresholds = STRATEGY_CONFIG.maxDeltaPctByRegime;
  const currentDeltaThreshold = deltaThresholds[currentRegime.regime] ?? 2;

  console.log(
    `Regime: ${currentRegime.regime} (confidence: ${(currentRegime.confidence * 100).toFixed(0)}%, sizing: ${currentRegime.positionSizePct}%, delta threshold: ±${currentDeltaThreshold}%)`
  );

  for (const signal of currentRegime.signals) {
    console.log(`  Signal: ${signal}`);
  }
}

async function runRebalance(driftClient: DriftClient): Promise<void> {
  console.log("\n--- Rebalance Cycle ---");

  if (!currentRegime) {
    console.log("No regime data yet — skipping rebalance");
    return;
  }

  // Check if we should pause
  const { pause, reason } = shouldPauseTrading(currentRegime);
  if (pause) {
    console.log(`PAUSED: ${reason}`);
    if (currentRegime.regime === "extreme") {
      for (const marketIndex of activeMarkets) {
        await closeVolPosition(driftClient, marketIndex);
      }
      activeMarkets.clear();
    }
    return;
  }

  // Get equity
  const user = driftClient.getUser();
  const totalEquity = user.getTotalCollateral().toNumber() / 1e6;
  console.log(`Total equity: $${totalEquity.toFixed(2)}`);

  // Pre-extreme wind-down check
  const avgVolBps =
    [...volStates.values()].reduce((sum, v) => sum + v.realizedVolBps, 0) /
    Math.max(volStates.size, 1);
  if (avgVolBps > STRATEGY_CONFIG.preExtremeWindDownBps) {
    console.log(
      `Pre-extreme wind-down: avg vol ${(avgVolBps / 100).toFixed(1)}% > ${STRATEGY_CONFIG.preExtremeWindDownBps / 100}% threshold — reducing to 50% of regime sizing`
    );
  }

  // Size and open/adjust positions per market
  const perpMarkets = Object.values(DRIFT_PERP_MARKETS);
  for (const market of perpMarkets) {
    if (!STRATEGY_CONFIG.primaryMarkets.includes(market.name)) continue;

    const volState = volStates.get(market.name);
    if (!volState) continue;

    // === FUNDING GATE (highest priority filter) ===
    const funding = fundingStates.get(market.name);
    if (funding) {
      const gate = passesFundingGate(funding);
      if (!gate.pass) {
        // Close position if funding turned bad
        if (activeMarkets.has(market.index)) {
          console.log(`Closing ${market.name}: ${gate.reason}`);
          await closeVolPosition(driftClient, market.index);
          activeMarkets.delete(market.index);
        }
        continue;
      }
    }

    const { sizeUsd, skip, reason } = computeVolTradeSize(
      totalEquity,
      currentRegime,
      volState,
      market.index
    );

    // Apply pre-extreme wind-down
    let adjustedSize = sizeUsd;
    if (avgVolBps > STRATEGY_CONFIG.preExtremeWindDownBps) {
      adjustedSize *= 0.5;
    }

    if (skip || adjustedSize < 10) {
      if (activeMarkets.has(market.index)) {
        console.log(`Closing ${market.name}: ${reason}`);
        await closeVolPosition(driftClient, market.index);
        activeMarkets.delete(market.index);
      }
      continue;
    }

    // Open position if not already in
    if (!activeMarkets.has(market.index)) {
      try {
        await openVolPosition(driftClient, market.index, adjustedSize);
        activeMarkets.add(market.index);
      } catch (err) {
        console.error(`Failed to open vol position on ${market.name}:`, err);
      }
    }
  }

  // Delta hedge with regime-aware threshold
  const delta = computePortfolioDelta(driftClient);
  const { hedge, hedgeSizeUsd, direction, threshold } = needsHedge(
    delta,
    currentRegime.regime
  );

  console.log(
    `Portfolio delta: $${delta.netDeltaUsd.toFixed(2)} (${delta.deltaPct.toFixed(1)}%, threshold: ±${threshold}%)`
  );

  if (hedge) {
    console.log(
      `Delta hedge needed: ${direction} $${hedgeSizeUsd.toFixed(2)}`
    );
    try {
      await executeDeltaHedge(driftClient, hedgeSizeUsd, direction);
    } catch (err) {
      console.error("Delta hedge failed:", err);
    }
  }
}

async function main(): Promise<void> {
  console.log("⛈️  Arashi Keeper Starting...");
  console.log("Strategy: Delta-neutral volatility harvesting");
  console.log(
    "Risk controls: Funding filter, dynamic delta, health monitoring, pre-extreme wind-down\n"
  );

  const connection = getConnection();
  const managerKeypair = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`Manager: ${managerKeypair.publicKey.toBase58()}`);

  const driftClient = await initDriftClient(connection, managerKeypair);
  console.log("Drift client connected.\n");

  // Initial computation
  await updateVolatility();
  await updateFunding();
  await updateRegime();

  let lastVolUpdate = Date.now();
  let lastRegimeCheck = Date.now();
  let lastRebalance = 0;
  let lastEmergencyCheck = 0;
  let lastFundingUpdate = Date.now();

  while (true) {
    const now = Date.now();

    // Emergency checks (every 30s)
    if (now - lastEmergencyCheck >= STRATEGY_CONFIG.emergencyCheckIntervalMs) {
      try {
        const emergency = await runEmergencyChecks(driftClient);
        if (emergency) {
          console.log("Emergency — pausing rebalance for 5 minutes");
          lastRebalance = now;
        }
      } catch (err) {
        console.error("Emergency check error:", err);
      }
      lastEmergencyCheck = now;
    }

    // Regime check (every 3 min)
    if (now - lastRegimeCheck >= STRATEGY_CONFIG.regimeCheckIntervalMs) {
      await updateRegime();
      lastRegimeCheck = now;
    }

    // Vol update (every 10 min)
    if (now - lastVolUpdate >= STRATEGY_CONFIG.volUpdateIntervalMs) {
      try {
        await updateVolatility();
      } catch (err) {
        console.error("Vol update error:", err);
      }
      lastVolUpdate = now;
    }

    // Funding update (every 10 min, same as vol)
    if (now - lastFundingUpdate >= STRATEGY_CONFIG.volUpdateIntervalMs) {
      try {
        await updateFunding();
      } catch (err) {
        console.error("Funding update error:", err);
      }
      lastFundingUpdate = now;
    }

    // Rebalance (every 30 min)
    if (now - lastRebalance >= STRATEGY_CONFIG.rebalanceIntervalMs) {
      try {
        await runRebalance(driftClient);
      } catch (err) {
        console.error("Rebalance error:", err);
      }
      lastRebalance = now;
    }

    // Heartbeat
    const equity = driftClient.getUser().getTotalCollateral().toNumber() / 1e6;
    if (equity > peakEquity) peakEquity = equity;

    console.log(
      `[${new Date().toISOString()}] Regime: ${currentRegime?.regime ?? "?"} | Positions: ${activeMarkets.size} | Equity: $${equity.toFixed(2)} | Next rebalance: ${Math.round(
        (STRATEGY_CONFIG.rebalanceIntervalMs - (now - lastRebalance)) / 60000
      )}min`
    );

    await sleep(30_000); // 30s tick (aligned with emergency checks)
  }
}

main().catch((err) => {
  console.error("Arashi keeper fatal error:", err);
  process.exit(1);
});
