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
  // Reduced across the board — extreme now triggers pre-emptive wind-down
  regimeSizing: {
    veryLow: 5, // Minimal — premium too thin (was 10%)
    low: 20, // Moderate (was 30%)
    normal: 35, // Optimal — richest risk-adjusted premium (was 50%)
    high: 15, // Significant scale-back (was 30%)
    extreme: 0, // Full stop
  } as Record<string, number>,

  // Pre-extreme wind-down: start reducing when vol > 60% (between high and extreme)
  preExtremeWindDownBps: 6000, // At 60% vol, begin reducing to 50% of high-regime sizing

  // === FUNDING POLARITY FILTER (HIGHEST PRIORITY — new) ===
  // The primary condition for entry is positive funding, NOT just high vol.
  // "If the core of the strategy is harvesting funding, the primary condition
  //  should be Funding Rate > 0" — reviewer
  minFundingRateToEnter: 0.0001, // Minimum positive funding rate (per hour)
  fundingMustBePositive: true, // Hard gate: no entry when funding < 0
  // Cost gate: expected funding must exceed hedging costs
  driftTakerFeeBps: 3.5,
  estimatedSlippageBps: 5,
  minHoldingPeriodHours: 12, // Shorter hold for vol trades

  // === DYNAMIC DELTA THRESHOLDS (new) ===
  // Delta threshold tightens with regime — addresses "±5% is too loose" critique
  maxDeltaPctByRegime: {
    veryLow: 5, // Loose in calm markets — cheap to hedge
    low: 3, // Tighter
    normal: 2, // Tight — vol premium fragile if directional
    high: 1, // Very tight — any delta is a gamble
    extreme: 0.5, // Near-zero — emergency mode
  } as Record<string, number>,
  hedgeMarket: 0, // SOL-PERP as primary hedge instrument

  // === HEALTH MONITORING (new) ===
  minHealthRatio: 1.15,
  criticalHealthRatio: 1.08,
  healthCheckIntervalMs: 30 * 1000, // Every 30 seconds

  // Risk limits — tightened
  maxDrawdownPct: 5, // 5% warning — reduce positions (was 8%)
  severeDrawdownPct: 8, // 8% emergency — close all
  maxVegaExposurePct: 10, // 10% (was 15%)
  maxLeverage: 1.5, // Reduced from 3x — vol strategies need lower leverage

  // Timing — faster for emergency response
  volUpdateIntervalMs: 10 * 60 * 1000, // Compute vol every 10 min (was 15)
  rebalanceIntervalMs: 30 * 60 * 1000, // Rebalance every 30 min (was 60)
  regimeCheckIntervalMs: 3 * 60 * 1000, // Check regime every 3 min (was 5)
  emergencyCheckIntervalMs: 30 * 1000, // Health/drawdown every 30s
};

export let vaultAddress = process.env.VAULT_ADDRESS
  ? new PublicKey(process.env.VAULT_ADDRESS)
  : PublicKey.default;

export let lookupTableAddress = process.env.LOOKUP_TABLE_ADDRESS
  ? new PublicKey(process.env.LOOKUP_TABLE_ADDRESS)
  : PublicKey.default;
