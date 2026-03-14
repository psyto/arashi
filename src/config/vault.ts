import { PublicKey } from "@solana/web3.js";
import { USDC_MINT, SPL_TOKEN_PROGRAM_ID } from "./constants";
import BN from "bn.js";

// Vault configuration
export const VAULT_CONFIG = {
  name: "Arashi",
  description:
    "Arashi Vault — Delta-neutral volatility harvesting. Arashi rides the storm.",

  assetMintAddress: USDC_MINT,
  assetTokenProgram: SPL_TOKEN_PROGRAM_ID,

  maxCap: new BN(1_000_000 * 1e6), // 1M USDC
  managementFee: new BN(150), // 1.5% annual
  issuanceFee: new BN(0),
  redemptionFee: new BN(15), // 0.15% withdrawal fee
  performanceFee: new BN(2000), // 20% performance fee
  withdrawalWaitingPeriod: new BN(86400), // 24 hours
  lockedProfitDegradationDuration: new BN(3600),
};

// Volatility strategy parameters
export const STRATEGY_CONFIG = {
  // Markets to trade vol on
  primaryMarkets: ["SOL-PERP", "BTC-PERP", "ETH-PERP"],

  // Vol regime thresholds (annualized, in bps)
  regimeThresholds: {
    veryLow: 2000, // < 20%
    low: 3500, // 20-35%
    normal: 5000, // 35-50%
    high: 7500, // 50-75%
    extreme: 10000, // > 75%
  },

  // Position sizing by regime (% of total equity)
  regimeSizing: {
    veryLow: 10, // Small positions — low premium
    low: 30, // Moderate
    normal: 50, // Optimal — vol premium richest relative to risk
    high: 30, // Scale back — risk rising
    extreme: 0, // Stop trading — wait for storm to pass
  },

  // Delta hedging
  maxDeltaPct: 5, // Rehedge when portfolio delta > ±5% of notional
  hedgeMarket: 0, // SOL-PERP as primary hedge instrument

  // Risk limits
  maxDrawdownPct: 8, // 8% max drawdown
  maxVegaExposurePct: 15, // Max 15% of equity as vega
  maxLeverage: 3,

  // Timing
  volUpdateIntervalMs: 15 * 60 * 1000, // Compute vol every 15 min
  rebalanceIntervalMs: 60 * 60 * 1000, // Rebalance every 1 hour
  regimeCheckIntervalMs: 5 * 60 * 1000, // Check regime every 5 min
};

export let vaultAddress = process.env.VAULT_ADDRESS
  ? new PublicKey(process.env.VAULT_ADDRESS)
  : PublicKey.default;

export let lookupTableAddress = process.env.LOOKUP_TABLE_ADDRESS
  ? new PublicKey(process.env.LOOKUP_TABLE_ADDRESS)
  : PublicKey.default;
