import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  initialize,
  DriftEnv,
  PositionDirection,
  OrderType,
  MarketType,
  BN,
  getMarketsAndOraclesForSubscription,
} from "@drift-labs/sdk";
import { getConnection, loadKeypair, sleep } from "../utils/helpers";
import { computeVolState } from "../keeper/vol-engine";
import { classifyRegime, detectRegime } from "../keeper/regime-detector";
import { fetchMarketFunding, passesFundingGate } from "../keeper/funding-filter";
import { getDeltaThreshold } from "../keeper/delta-hedger";
import { STRATEGY_CONFIG } from "../config/vault";

async function main() {
  console.log("⛈️  Arashi Devnet Trading Test\n");

  // Use public devnet RPC — QuickNode free plan limits getMultipleAccounts to 5
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const manager = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`Manager: ${manager.publicKey.toBase58()}`);
  const balance = await connection.getBalance(manager.publicKey);
  console.log(`SOL balance: ${(balance / 1e9).toFixed(4)}\n`);

  // Initialize Drift SDK for devnet
  const sdkConfig = initialize({ env: "devnet" as DriftEnv });
  const wallet = new Wallet(manager);

  const { perpMarketIndexes, spotMarketIndexes, oracleInfos } =
    getMarketsAndOraclesForSubscription("devnet" as DriftEnv);

  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    accountSubscription: {
      type: "websocket",
    },
    env: "devnet",
    perpMarketIndexes,
    spotMarketIndexes,
    oracleInfos,
  });

  await driftClient.subscribe();
  console.log("Drift client connected.\n");

  // Step 1: Initialize user if needed
  console.log("=== Step 1: Initialize Drift User ===");
  try {
    const user = driftClient.getUser();
    const equity = user.getTotalCollateral().toNumber() / 1e6;
    console.log(`User account exists. Equity: $${equity.toFixed(2)}`);
  } catch {
    console.log("No user account found. Initializing...");
    try {
      const txSig = await driftClient.initializeUserAccount();
      console.log(`User account initialized: ${txSig}`);
      await sleep(2000);
    } catch (err) {
      console.error("Failed to initialize user account:", err);
      await driftClient.unsubscribe();
      return;
    }
  }

  // Step 2: Vol engine — compute realized vol for all markets
  console.log("\n=== Step 2: Volatility Engine ===");
  const volStates = new Map();
  for (const market of STRATEGY_CONFIG.primaryMarkets) {
    try {
      const volState = await computeVolState(market);
      volStates.set(market, volState);
      const regime = classifyRegime(volState.realizedVolBps);
      const deltaThreshold = getDeltaThreshold(regime);
      console.log(
        `  ${market}: ` +
          `realized=${(volState.realizedVol * 100).toFixed(1)}% | ` +
          `regime=${regime} | ` +
          `delta threshold=±${deltaThreshold}% | ` +
          `${volState.isElevated ? "ELEVATED " : ""}` +
          `${volState.isDepressed ? "DEPRESSED " : ""}`
      );
    } catch (err) {
      console.error(`  ${market}: Failed -`, (err as Error).message);
    }
  }

  // Step 3: Regime detection
  console.log("\n=== Step 3: Regime Detection ===");
  if (volStates.size > 0) {
    const regime = detectRegime(volStates);
    console.log(`Aggregate regime: ${regime.regime}`);
    console.log(`Position sizing: ${regime.positionSizePct}%`);
    console.log(`Confidence: ${(regime.confidence * 100).toFixed(0)}%`);

    // Pre-extreme wind-down check
    const avgVolBps =
      [...volStates.values()].reduce(
        (sum: number, v: any) => sum + v.realizedVolBps,
        0
      ) / volStates.size;
    if (avgVolBps > STRATEGY_CONFIG.preExtremeWindDownBps) {
      console.log(
        `PRE-EXTREME WIND-DOWN: avg vol ${(avgVolBps / 100).toFixed(1)}% > 60% threshold`
      );
      console.log(`  Would reduce sizing to ${regime.positionSizePct * 0.5}%`);
    }

    for (const signal of regime.signals) {
      console.log(`  Signal: ${signal}`);
    }
  }

  // Step 4: Funding polarity filter
  console.log("\n=== Step 4: Funding Polarity Filter ===");
  for (const market of STRATEGY_CONFIG.primaryMarkets) {
    try {
      const funding = await fetchMarketFunding(market);
      const gate = passesFundingGate(funding);
      const symbol = gate.pass ? "✓" : "✗";
      console.log(
        `  ${symbol} ${market}: ${funding.annualizedPct.toFixed(2)}% APY | ${gate.reason}`
      );
    } catch (err) {
      console.error(`  ${market}: Failed -`, (err as Error).message);
    }
  }

  // Step 5: Health monitor
  console.log("\n=== Step 5: Health Monitor ===");
  try {
    const user = driftClient.getUser();
    const equity = user.getTotalCollateral().toNumber() / 1e6;
    const margin = user.getMaintenanceMarginRequirement().toNumber() / 1e6;
    const pnl = user.getUnrealizedPNL(true).toNumber() / 1e6;
    const healthRatio = margin > 0 ? equity / margin : Infinity;

    console.log(`Total collateral: $${equity.toFixed(2)}`);
    console.log(`Maintenance margin: $${margin.toFixed(2)}`);
    console.log(
      `Health ratio: ${healthRatio === Infinity ? "∞ (no positions)" : healthRatio.toFixed(3)}`
    );
    console.log(`Unrealized PnL: $${pnl.toFixed(2)}`);

    const perpPositions = user.getActivePerpPositions();
    console.log(`Active perp positions: ${perpPositions.length}`);
    perpPositions.forEach((pos) => {
      console.log(
        `  Market ${pos.marketIndex}: size=${pos.baseAssetAmount.toString()}`
      );
    });
  } catch (err) {
    console.error("Health check error:", err);
  }

  // Step 6: Trade test (if collateral available)
  console.log("\n=== Step 6: Trade Test ===");
  try {
    const user = driftClient.getUser();
    const equity = user.getTotalCollateral().toNumber() / 1e6;

    if (equity > 0) {
      // Check funding gate first
      const funding = await fetchMarketFunding("SOL-PERP");
      const gate = passesFundingGate(funding);
      console.log(
        `SOL-PERP funding gate: ${gate.pass ? "PASS" : "FAIL"} (${gate.reason})`
      );

      if (gate.pass) {
        console.log("Placing test SHORT on SOL-PERP...");
        const oracle = driftClient.getOracleDataForPerpMarket(0);
        const price = oracle.price.toNumber() / 1e6;
        const baseAmount = (1 / price) * 1e9;

        const txSig = await driftClient.placePerpOrder({
          orderType: OrderType.MARKET,
          marketType: MarketType.PERP,
          marketIndex: 0,
          direction: PositionDirection.SHORT,
          baseAssetAmount: new BN(Math.floor(baseAmount)),
        });

        console.log(`Trade executed: ${txSig}`);
        await sleep(3000);

        // Close
        const pos = user.getPerpPosition(0);
        if (pos && !pos.baseAssetAmount.isZero()) {
          console.log("Closing test position...");
          const closeTx = await driftClient.placePerpOrder({
            orderType: OrderType.MARKET,
            marketType: MarketType.PERP,
            marketIndex: 0,
            direction: PositionDirection.LONG,
            baseAssetAmount: pos.baseAssetAmount.abs(),
            reduceOnly: true,
          });
          console.log(`Position closed: ${closeTx}`);
        }
      } else {
        console.log(
          "Funding gate BLOCKED trade — strategy working as intended (would not enter negative funding)"
        );
      }
    } else {
      console.log(
        "No collateral — skipping trade. Deposit devnet USDC via https://beta.drift.trade"
      );
    }
  } catch (err) {
    console.error("Trade test error:", err);
  }

  console.log("\n=== Devnet Trading Test Complete ===");
  await driftClient.unsubscribe();
}

main().catch(console.error);
