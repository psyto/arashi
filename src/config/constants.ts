import { PublicKey } from "@solana/web3.js";

// Program IDs
export const VOLTR_VAULT_PROGRAM_ID = new PublicKey(
  "vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8"
);
export const DRIFT_ADAPTOR_PROGRAM_ID = new PublicKey(
  "EBN93eXs5fHGBABuajQqdsKRkCgaqtJa8vEFD6vKXiP"
);
export const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);

// Token mints
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

// Drift account addresses
export const DRIFT_SPOT_STATE = new PublicKey(
  "5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN"
);
export const DRIFT_LOOKUP_TABLE = new PublicKey(
  "Fpys8GRa5RBWfyeN7AaDUwFGD1zkDCA4z3t4CJLV8dfL"
);

// Drift perp markets used for vol trading and hedging
export const DRIFT_PERP_MARKETS = {
  SOL: { index: 0, name: "SOL-PERP" },
  BTC: { index: 1, name: "BTC-PERP" },
  ETH: { index: 2, name: "ETH-PERP" },
} as const;

// Drift API
export const DRIFT_DATA_API = "https://data.api.drift.trade";

// Instruction discriminators for Drift adaptor
export const DISCRIMINATORS = {
  INITIALIZE_USER: Buffer.from([200, 103, 130, 67, 230, 84, 7, 225]),
  INITIALIZE_EARN: Buffer.from([152, 254, 77, 125, 32, 244, 220, 149]),
  DEPOSIT_USER: Buffer.from([162, 73, 130, 153, 234, 34, 17, 56]),
  DEPOSIT_EARN: Buffer.from([22, 219, 117, 134, 59, 142, 142, 178]),
  WITHDRAW_USER: Buffer.from([86, 169, 152, 107, 33, 180, 134, 115]),
  WITHDRAW_EARN: Buffer.from([70, 218, 208, 97, 147, 24, 19, 169]),
} as const;

// Precision constants (Drift)
export const BASE_PRECISION = 1_000_000_000; // 1e9
export const PRICE_PRECISION = 1_000_000; // 1e6
export const FUNDING_RATE_PRECISION = 1_000_000_000; // 1e9
export const USDC_DECIMALS = 6;

// Volatility constants
export const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
export const HOURS_PER_YEAR = 365.25 * 24;
