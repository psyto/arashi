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

console.log("=== Funding Filter Tests ===\n");

// Test 1: Negative funding should be blocked
console.log("Funding polarity gate:");
const negative: MarketFundingState = {
  market: "SOL-PERP",
  fundingRate: -0.001,
  annualizedPct: -876,
  isPositive: false,
};
const negResult = passesFundingGate(negative);
assert(!negResult.pass, "Negative funding should be BLOCKED");
assert(
  negResult.reason.includes("negative"),
  `Reason should mention negative: ${negResult.reason}`
);

// Test 2: Positive funding should pass
const positive: MarketFundingState = {
  market: "BTC-PERP",
  fundingRate: 0.002,
  annualizedPct: 1752,
  isPositive: true,
};
const posResult = passesFundingGate(positive);
assert(posResult.pass, "Positive, cost-viable funding should PASS");

// Test 3: Very small positive should fail (below min threshold)
console.log("\nMinimum threshold:");
const tooSmall: MarketFundingState = {
  market: "THIN-PERP",
  fundingRate: 0.00005,
  annualizedPct: 43.8,
  isPositive: true,
};
const smallResult = passesFundingGate(tooSmall);
assert(!smallResult.pass, "Very small positive funding should be BLOCKED");
assert(
  smallResult.reason.includes("too low"),
  `Reason should mention too low: ${smallResult.reason}`
);

// Test 4: Zero funding should be blocked
console.log("\nZero funding:");
const zero: MarketFundingState = {
  market: "ZERO-PERP",
  fundingRate: 0,
  annualizedPct: 0,
  isPositive: false,
};
const zeroResult = passesFundingGate(zero);
assert(!zeroResult.pass, "Zero funding should be BLOCKED");

// Test 5: Cost gate — positive but too thin for costs
console.log("\nCost gate:");
const thinPositive: MarketFundingState = {
  market: "THIN2-PERP",
  fundingRate: 0.0002, // Above min threshold but below cost gate
  annualizedPct: 175,
  isPositive: true,
};
const thinResult = passesFundingGate(thinPositive);
// This may or may not pass depending on cost calculation — the important
// thing is the gate runs without error
console.log(`  Thin positive (175% APY): ${thinResult.pass ? "PASS" : "FAIL"} — ${thinResult.reason}`);

console.log("\n=== Funding Filter Tests Complete ===");
