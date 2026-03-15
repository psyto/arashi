import {
  classifyRegime,
  detectRegime,
  shouldPauseTrading,
  RegimeState,
} from "../keeper/regime-detector";
import { VolState } from "../keeper/vol-engine";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

console.log("=== Regime Detector Tests ===\n");

// Test 1: Regime classification
console.log("Regime classification:");
assert(classifyRegime(1500) === "veryLow", "15% → veryLow");
assert(classifyRegime(2500) === "low", "25% → low");
assert(classifyRegime(4000) === "normal", "40% → normal");
assert(classifyRegime(6000) === "high", "60% → high");
assert(classifyRegime(8000) === "extreme", "80% → extreme");
assert(classifyRegime(10000) === "extreme", "100% → extreme");

// Test 2: Aggregate regime uses highest across markets
console.log("\nAggregate regime:");
const volStates = new Map<string, VolState>();
volStates.set("SOL-PERP", {
  realizedVol: 0.8,
  realizedVolBps: 8000,
  emaVol7d: 0.7,
  emaVol30d: 0.5,
  isElevated: true,
  isDepressed: false,
  sampleCount: 168,
  lastUpdated: Date.now(),
});
volStates.set("BTC-PERP", {
  realizedVol: 0.3,
  realizedVolBps: 3000,
  emaVol7d: 0.25,
  emaVol30d: 0.2,
  isElevated: false,
  isDepressed: false,
  sampleCount: 168,
  lastUpdated: Date.now(),
});

const regime = detectRegime(volStates);
assert(
  regime.regime === "extreme",
  `Aggregate should be extreme (highest), got ${regime.regime}`
);
assert(regime.positionSizePct === 0, "Extreme → 0% sizing");

// Test 3: Should pause in extreme
console.log("\nPause logic:");
const { pause, reason } = shouldPauseTrading(regime);
assert(pause, "Should pause in extreme regime");
assert(reason.includes("Extreme"), `Reason should mention extreme: ${reason}`);

// Test 4: Should NOT pause in normal
const normalVols = new Map<string, VolState>();
normalVols.set("SOL-PERP", {
  realizedVol: 0.4,
  realizedVolBps: 4000,
  emaVol7d: 0.35,
  emaVol30d: 0.3,
  isElevated: false,
  isDepressed: false,
  sampleCount: 168,
  lastUpdated: Date.now(),
});
const normalRegime = detectRegime(normalVols);
const normalPause = shouldPauseTrading(normalRegime);
assert(!normalPause.pause, "Should NOT pause in normal regime");
assert(normalRegime.positionSizePct === 40, `Normal sizing should be 40% (got ${normalRegime.positionSizePct})`);

// Test 5: Regime transition detection
console.log("\nTransition detection:");
const prevRegime: RegimeState = {
  regime: "normal",
  positionSizePct: 35,
  confidence: 1,
  signals: [],
  lastTransition: Date.now() - 60000,
  transitionCount: 0,
};
const newRegime = detectRegime(volStates, prevRegime); // extreme
assert(
  newRegime.transitionCount === 1,
  `Transition count should be 1 (got ${newRegime.transitionCount})`
);
assert(
  newRegime.signals.some((s) => s.includes("transition")),
  "Should signal a regime transition"
);

// Test 6: Rapid transitions should trigger pause
console.log("\nRapid transition pause:");
const rapidRegime: RegimeState = {
  regime: "normal",
  positionSizePct: 35,
  confidence: 1,
  signals: [],
  lastTransition: Date.now(),
  transitionCount: 4, // >3 transitions
};
const rapidPause = shouldPauseTrading(rapidRegime);
assert(rapidPause.pause, "Should pause on rapid transitions (>3)");

console.log("\n=== Regime Detector Tests Complete ===");
