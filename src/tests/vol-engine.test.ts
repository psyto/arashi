import {
  computeParkinsonVol,
  computeCloseToCloseVol,
  computeYangZhangVol,
  emaSmooth,
  CandleData,
} from "../keeper/vol-engine";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

console.log("=== Volatility Engine Tests ===\n");

// Generate synthetic candle data with known volatility
function generateCandles(
  basePrice: number,
  dailyVol: number, // decimal, e.g., 0.5 = 50%
  hours: number
): CandleData[] {
  const hourlyVol = dailyVol / Math.sqrt(24);
  const candles: CandleData[] = [];
  let price = basePrice;

  for (let i = 0; i < hours; i++) {
    const move = price * hourlyVol * (Math.random() * 2 - 1);
    const open = price;
    const close = price + move;
    const high = Math.max(open, close) * (1 + Math.random() * hourlyVol * 0.5);
    const low = Math.min(open, close) * (1 - Math.random() * hourlyVol * 0.5);
    price = close;

    candles.push({
      ts: 1700000000 + i * 3600,
      oracleOpen: open,
      oracleClose: close,
      oracleHigh: high,
      oracleLow: low,
      quoteVolume: 1000000,
    });
  }
  return candles;
}

// Test 1: Parkinson estimator — should produce reasonable vol
console.log("Parkinson estimator:");
const candles50 = generateCandles(100, 0.5, 168); // 50% daily vol, 7 days
const pkVol = computeParkinsonVol(candles50);
console.log(`  50% daily vol input → Parkinson output: ${(pkVol * 100).toFixed(1)}%`);
assert(pkVol > 0.1, `Parkinson vol should be > 10% (got ${(pkVol * 100).toFixed(1)}%)`);
assert(pkVol < 10.0, `Parkinson vol should be < 1000% (got ${(pkVol * 100).toFixed(1)}%)`);

// Test 2: Close-to-close estimator
console.log("\nClose-to-close estimator:");
const c2cVol = computeCloseToCloseVol(candles50);
console.log(`  50% daily vol input → C2C output: ${(c2cVol * 100).toFixed(1)}%`);
assert(c2cVol > 0.1, `C2C vol should be > 10% (got ${(c2cVol * 100).toFixed(1)}%)`);
assert(c2cVol < 10.0, `C2C vol should be < 1000% (got ${(c2cVol * 100).toFixed(1)}%)`);

// Test 3: Yang-Zhang estimator
console.log("\nYang-Zhang estimator:");
const yzVol = computeYangZhangVol(candles50);
console.log(`  50% daily vol input → YZ output: ${(yzVol * 100).toFixed(1)}%`);
assert(yzVol > 0.1, `YZ vol should be > 10% (got ${(yzVol * 100).toFixed(1)}%)`);
assert(yzVol < 10.0, `YZ vol should be < 1000% (got ${(yzVol * 100).toFixed(1)}%)`);

// Test 4: Low vol input should produce low vol output
console.log("\nLow vol detection:");
const candlesLow = generateCandles(100, 0.1, 168); // 10% daily vol
const pkLow = computeParkinsonVol(candlesLow);
console.log(`  10% daily vol input → Parkinson output: ${(pkLow * 100).toFixed(1)}%`);
assert(pkLow < pkVol, "Low vol candles should produce lower vol than high vol candles");

// Test 5: Empty / insufficient data
console.log("\nEdge cases:");
assert(computeParkinsonVol([]) === 0, "Empty candles → 0 vol");
assert(computeParkinsonVol([candles50[0]]) === 0, "Single candle → 0 vol");
assert(computeCloseToCloseVol([]) === 0, "Empty → 0 for C2C");
assert(computeYangZhangVol([]) === 0, "Empty → 0 for YZ");

// Test 6: EMA smoothing
console.log("\nEMA smoothing:");
const ema1 = emaSmooth(0.5, 0, 168, 1); // First value, no prior
assert(ema1 === 0.5, `First EMA should equal input (got ${ema1.toFixed(3)})`);

const ema2 = emaSmooth(0.6, 0.5, 168, 1); // Smooth toward new value
assert(ema2 > 0.5 && ema2 < 0.6, `EMA should be between 0.5 and 0.6 (got ${ema2.toFixed(3)})`);

const ema3 = emaSmooth(0.5, 0.5, 168, 1); // No change
assert(Math.abs(ema3 - 0.5) < 0.001, `Stable EMA should stay at 0.5 (got ${ema3.toFixed(3)})`);

console.log("\n=== Volatility Engine Tests Complete ===");
