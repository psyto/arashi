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

  maxCap: new BN(1_000_000 * 1e6),
  managementFee: new BN(150), // 1.5% annual
  issuanceFee: new BN(0),
  redemptionFee: new BN(15), // 0.15%
  performanceFee: new BN(2000), // 20%
  withdrawalWaitingPeriod: new BN(86400),
  lockedProfitDegradationDuration: new BN(3600),
};

// Volatility strategy parameters
export const STRATEGY_CONFIG = {
  // === LENDING YIELD ON IDLE CAPITAL (v4 — production) ===
  // Route idle capital to highest-yield lending protocol (not fixed Drift Earn).
  // Kamino (~6.5%), Marginfi (~5%), Drift Earn (~1.5%)
  enableLendingOnIdle: true,
  enableLendingOptimization: true, // Query multiple protocols for best rate
  lendingMarketIndex: 0, // USDC spot market on Drift (fallback)
  estimatedLendingAPY: 6, // Kamino as primary lending target

  // === LST COLLATERAL YIELD (v4 — production) ===
  // Use jitoSOL as collateral instead of plain SOL/USDC where possible.
  // Earns ~7-8% staking + MEV yield on collateral.
  enableLstYield: true,

  primaryMarkets: ["SOL-PERP", "BTC-PERP", "ETH-PERP"],

  // Vol regime thresholds (annualized, bps)
  regimeThresholds: {
    veryLow: 2000,
    low: 3500,
    normal: 5000,
    high: 7500,
    extreme: 10000,
  },

  // Position sizing by regime — RAISED for revenue (v2)
  // Previous sizing was too conservative, causing capital stagnation
  regimeSizing: {
    veryLow: 10, // Raised from 5% — even thin premium compounds over weeks
    low: 25, // Raised from 20%
    normal: 40, // Raised from 35% — optimal regime, maximize
    high: 20, // Raised from 15% — high vol has rich premium if funding positive
    extreme: 0, // Still zero — non-negotiable
  } as Record<string, number>,

  preExtremeWindDownBps: 6500, // Raised from 6000 — less premature wind-down

  // === FUNDING FILTER (v3 — bidirectional) ===
  // No longer blocks negative funding — trades BOTH directions
  // Positive funding → SHORT to collect | Negative funding → LONG to collect
  minFundingRateToEnter: 0.0001, // Minimum |funding rate| (either direction)
  fundingMustBePositive: false, // v3: DISABLED — we trade both ways

  // === ORDER EXECUTION (v2 — maker orders) ===
  useLimitOrders: true,
  driftMakerFeeBps: -0.2, // Maker REBATE
  driftTakerFeeBps: 3.5, // Taker fee (fallback)
  limitOrderSpreadBps: 2, // 0.02% from oracle
  limitOrderTimeoutMs: 60_000,
  estimatedSlippageBps: 1, // Lower with limits (was 5)
  minHoldingPeriodHours: 72, // 3-day hold minimum (was 12h — too short, caused churn)

  // === DYNAMIC DELTA THRESHOLDS ===
  maxDeltaPctByRegime: {
    veryLow: 5,
    low: 3,
    normal: 2,
    high: 1,
    extreme: 0.5,
  } as Record<string, number>,
  hedgeMarket: 0,

  // === EMERGENCY REGIME PUSH (v2 — addresses 10-min latency critique) ===
  // If price moves > emergencySigmaThreshold standard deviations in a single
  // health check interval, immediately recompute regime and resize
  emergencySigmaThreshold: 2.5, // 2.5σ move triggers immediate regime recheck
  enableEmergencyPush: true,

  // Health monitoring
  minHealthRatio: 1.15,
  criticalHealthRatio: 1.08,
  healthCheckIntervalMs: 30 * 1000,

  // Risk limits
  maxDrawdownPct: 5,
  severeDrawdownPct: 8,
  maxVegaExposurePct: 10,
  maxLeverage: 1.5,

  // === TIMING (v2 — balance between reactivity and cost) ===
  volUpdateIntervalMs: 5 * 60 * 1000, // 5 min (was 10 — faster regime detection)
  rebalanceIntervalMs: 2 * 60 * 60 * 1000, // 2 hours (was 30 min — reduce turnover)
  regimeCheckIntervalMs: 2 * 60 * 1000, // 2 min (was 3 — faster detection)
  emergencyCheckIntervalMs: 30 * 1000, // 30s (unchanged — safety-critical)
};

export let vaultAddress = process.env.VAULT_ADDRESS
  ? new PublicKey(process.env.VAULT_ADDRESS)
  : PublicKey.default;

export let lookupTableAddress = process.env.LOOKUP_TABLE_ADDRESS
  ? new PublicKey(process.env.LOOKUP_TABLE_ADDRESS)
  : PublicKey.default;
