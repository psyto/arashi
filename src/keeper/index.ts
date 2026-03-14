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

// State
const volStates = new Map<string, VolState>();
let currentRegime: RegimeState | undefined;
const activeMarkets = new Set<number>();

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

async function updateRegime(): Promise<void> {
  if (volStates.size === 0) return;

  const prevRegime = currentRegime;
  currentRegime = detectRegime(volStates, prevRegime);

  console.log(
    `Regime: ${currentRegime.regime} (confidence: ${(currentRegime.confidence * 100).toFixed(0)}%, sizing: ${currentRegime.positionSizePct}%)`
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
    // Close all positions in extreme regime
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

  // Size and open/adjust positions per market
  const perpMarkets = Object.values(DRIFT_PERP_MARKETS);
  for (const market of perpMarkets) {
    if (!STRATEGY_CONFIG.primaryMarkets.includes(market.name)) continue;

    const volState = volStates.get(market.name);
    if (!volState) continue;

    const { sizeUsd, skip, reason } = computeVolTradeSize(
      totalEquity,
      currentRegime,
      volState,
      market.index
    );

    if (skip) {
      // Close position if we're skipping this market
      if (activeMarkets.has(market.index)) {
        console.log(`Closing ${market.name}: ${reason}`);
        await closeVolPosition(driftClient, market.index);
        activeMarkets.delete(market.index);
      }
      continue;
    }

    // Open or adjust position
    if (!activeMarkets.has(market.index)) {
      try {
        await openVolPosition(driftClient, market.index, sizeUsd);
        activeMarkets.add(market.index);
      } catch (err) {
        console.error(`Failed to open vol position on ${market.name}:`, err);
      }
    }
  }

  // Delta hedge
  const delta = computePortfolioDelta(driftClient);
  console.log(
    `Portfolio delta: $${delta.netDeltaUsd.toFixed(2)} (${delta.deltaPct.toFixed(1)}%)`
  );

  const { hedge, hedgeSizeUsd, direction } = needsHedge(delta);
  if (hedge) {
    console.log(`Delta hedge needed: ${direction} $${hedgeSizeUsd.toFixed(2)}`);
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

  const connection = getConnection();
  const managerKeypair = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`Manager: ${managerKeypair.publicKey.toBase58()}`);
  console.log(`RPC: ${process.env.HELIUS_RPC_URL?.slice(0, 40)}...`);

  const driftClient = await initDriftClient(connection, managerKeypair);
  console.log("Drift client connected.\n");

  // Initial vol computation
  await updateVolatility();
  await updateRegime();

  // Main loop
  let lastVolUpdate = Date.now();
  let lastRegimeCheck = Date.now();
  let lastRebalance = 0;

  while (true) {
    const now = Date.now();

    // Vol update
    if (now - lastVolUpdate >= STRATEGY_CONFIG.volUpdateIntervalMs) {
      try {
        await updateVolatility();
      } catch (err) {
        console.error("Vol update error:", err);
      }
      lastVolUpdate = now;
    }

    // Regime check
    if (now - lastRegimeCheck >= STRATEGY_CONFIG.regimeCheckIntervalMs) {
      await updateRegime();
      lastRegimeCheck = now;
    }

    // Rebalance
    if (now - lastRebalance >= STRATEGY_CONFIG.rebalanceIntervalMs) {
      try {
        await runRebalance(driftClient);
      } catch (err) {
        console.error("Rebalance error:", err);
      }
      lastRebalance = now;
    }

    // Heartbeat
    console.log(
      `[${new Date().toISOString()}] Regime: ${currentRegime?.regime ?? "unknown"} | Positions: ${activeMarkets.size} | Next rebalance: ${Math.round(
        (STRATEGY_CONFIG.rebalanceIntervalMs - (now - lastRebalance)) / 60000
      )}min`
    );

    await sleep(60_000);
  }
}

main().catch((err) => {
  console.error("Arashi keeper fatal error:", err);
  process.exit(1);
});
