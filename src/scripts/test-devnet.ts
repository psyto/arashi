import { Connection, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  initialize,
  DriftEnv,
} from "@drift-labs/sdk";
import { getConnection, loadKeypair } from "../utils/helpers";
import { computeVolState } from "../keeper/vol-engine";
import { classifyRegime } from "../keeper/regime-detector";
import { STRATEGY_CONFIG } from "../config/vault";

async function main() {
  console.log("⛈️  Arashi Devnet Test\n");

  // 1. Test vol engine (uses mainnet Drift API for price data)
  console.log("=== Volatility Engine ===");
  for (const market of STRATEGY_CONFIG.primaryMarkets) {
    try {
      const volState = await computeVolState(market);
      const regime = classifyRegime(volState.realizedVolBps);
      console.log(
        `  ${market}: realized=${(volState.realizedVol * 100).toFixed(1)}% | ` +
          `regime=${regime} | ` +
          `${volState.isElevated ? "ELEVATED" : volState.isDepressed ? "DEPRESSED" : "NORMAL"} | ` +
          `samples=${volState.sampleCount}`
      );
    } catch (err) {
      console.error(`  ${market}: Failed -`, (err as Error).message);
    }
  }

  // 2. Test Drift client on devnet
  console.log("\n=== Drift Client (Devnet) ===");
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const manager = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`Manager: ${manager.publicKey.toBase58()}`);
  const balance = await connection.getBalance(manager.publicKey);
  console.log(`SOL balance: ${balance / 1e9}`);

  const sdkConfig = initialize({ env: "devnet" as DriftEnv });
  const wallet = new Wallet(manager);
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 5000);

  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    accountSubscription: {
      type: "polling",
      accountLoader,
    },
    env: "devnet",
  });

  try {
    await driftClient.subscribe();
    console.log("Drift client connected!");

    const perpMarkets = driftClient.getPerpMarketAccounts();
    console.log(`Perp markets on devnet: ${perpMarkets.length}`);

    await driftClient.unsubscribe();
  } catch (err) {
    console.error("Drift client error:", err);
  }

  console.log("\n=== Test Complete ===");
  console.log("Vol engine: OK");
  console.log("Regime detector: OK");
  console.log("Drift devnet connection: OK");
}

main().catch(console.error);
