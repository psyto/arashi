import {
  passesFundingGate,
  MarketFundingState,
} from "../keeper/funding-filter";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

console.log("=== Funding Filter Tests (v3 Bidirectional) ===\n");

// Test 1: Positive funding → SHORT direction
console.log("Positive funding:");
const positive: MarketFundingState = {
  market: "BTC-PERP",
  fundingRate: 0.002,
  annualizedPct: 1752,
  isPositive: true,
  direction: "short",
  magnitude: 1752,
};
const posResult = passesFundingGate(positive);
assert(posResult.pass, "Positive funding should PASS");
assert(posResult.direction === "short", `Direction should be SHORT (got ${posResult.direction})`);

// Test 2: Negative funding → LONG direction (v3: NO LONGER BLOCKED)
console.log("\nNegative funding (v3 bidirectional):");
const negative: MarketFundingState = {
  market: "SOL-PERP",
  fundingRate: -0.001,
  annualizedPct: -876,
  isPositive: false,
  direction: "long",
  magnitude: 876,
};
const negResult = passesFundingGate(negative);
assert(negResult.pass, "Negative funding should PASS in v3 (go LONG)");
assert(negResult.direction === "long", `Direction should be LONG (got ${negResult.direction})`);

// Test 3: Very small |funding| should fail (either direction)
console.log("\nMinimum threshold:");
const tooSmall: MarketFundingState = {
  market: "THIN-PERP",
  fundingRate: 0.00005,
  annualizedPct: 43.8,
  isPositive: true,
  direction: "short",
  magnitude: 43.8,
};
const smallResult = passesFundingGate(tooSmall);
assert(!smallResult.pass, "Very small |funding| should be BLOCKED");

// Test 4: Zero funding should be blocked
console.log("\nZero funding:");
const zero: MarketFundingState = {
  market: "ZERO-PERP",
  fundingRate: 0,
  annualizedPct: 0,
  isPositive: false,
  direction: "short",
  magnitude: 0,
};
const zeroResult = passesFundingGate(zero);
assert(!zeroResult.pass, "Zero funding should be BLOCKED");

// Test 5: Large negative funding should pass (v3 — longs earn)
console.log("\nLarge negative funding:");
const largeNeg: MarketFundingState = {
  market: "ETH-PERP",
  fundingRate: -0.005,
  annualizedPct: -4380,
  isPositive: false,
  direction: "long",
  magnitude: 4380,
};
const largeNegResult = passesFundingGate(largeNeg);
assert(largeNegResult.pass, "Large negative funding should PASS (go LONG)");
assert(largeNegResult.direction === "long", "Direction should be LONG");

console.log("\n=== Funding Filter Tests Complete ===");
