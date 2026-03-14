import { DRIFT_DATA_API, SECONDS_PER_YEAR, HOURS_PER_YEAR } from "../config/constants";

export interface CandleData {
  ts: number;
  oracleOpen: number;
  oracleHigh: number;
  oracleClose: number;
  oracleLow: number;
  quoteVolume: number;
}

export interface VolState {
  realizedVol: number; // Annualized, decimal (e.g., 0.45 = 45%)
  realizedVolBps: number; // In bps (e.g., 4500 = 45%)
  emaVol7d: number;
  emaVol30d: number;
  isElevated: boolean; // Current > 1.5x ema30d
  isDepressed: boolean; // Current < 0.5x ema30d
  sampleCount: number;
  lastUpdated: number;
}

export async function fetchCandles(
  market: string,
  resolution: string = "60", // 1 hour
  limit: number = 168 // 7 days
): Promise<CandleData[]> {
  const res = await fetch(
    `${DRIFT_DATA_API}/market/${market}/candles/${resolution}?limit=${limit}`
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch candles for ${market}: ${res.status}`);
  }
  const body = (await res.json()) as { success: boolean; records: CandleData[] };
  if (!body.success || !body.records) {
    throw new Error(`Unexpected candle API response for ${market}`);
  }
  return body.records;
}

/**
 * Parkinson volatility estimator — uses high/low range
 * More efficient than close-to-close for the same number of observations
 *
 * sigma^2 = 1 / (4 * n * ln(2)) * sum(ln(H/L))^2
 */
export function computeParkinsonVol(candles: CandleData[]): number {
  if (candles.length < 2) return 0;

  const ln2x4 = 4 * Math.LN2;
  let sumLogHL2 = 0;
  let validCount = 0;

  for (const c of candles) {
    if (c.oracleHigh <= 0 || c.oracleLow <= 0 || c.oracleHigh < c.oracleLow) {
      continue;
    }
    const logHL = Math.log(c.oracleHigh / c.oracleLow);
    sumLogHL2 += logHL * logHL;
    validCount++;
  }

  if (validCount === 0) return 0;

  const variance = sumLogHL2 / (ln2x4 * validCount);
  // Annualize: assuming hourly candles
  const annualizedVariance = variance * HOURS_PER_YEAR;
  return Math.sqrt(annualizedVariance);
}

/**
 * Close-to-close volatility estimator — standard log-return approach
 */
export function computeCloseToCloseVol(candles: CandleData[]): number {
  if (candles.length < 3) return 0;

  const logReturns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].oracleClose > 0 && candles[i - 1].oracleClose > 0) {
      logReturns.push(
        Math.log(candles[i].oracleClose / candles[i - 1].oracleClose)
      );
    }
  }

  if (logReturns.length < 2) return 0;

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance =
    logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    (logReturns.length - 1);

  // Annualize
  return Math.sqrt(variance * HOURS_PER_YEAR);
}

/**
 * Yang-Zhang volatility estimator — combines overnight and intraday components
 * Most efficient estimator for drift-adjusted data
 */
export function computeYangZhangVol(candles: CandleData[]): number {
  if (candles.length < 3) return 0;

  const n = candles.length - 1;
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));

  // Overnight variance (close-to-open)
  let overnightVar = 0;
  // Open-to-close variance
  let openCloseVar = 0;
  // Rogers-Satchell variance (intraday)
  let rsVar = 0;

  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].oracleClose;
    const open = candles[i].oracleOpen;
    const high = candles[i].oracleHigh;
    const low = candles[i].oracleLow;
    const close = candles[i].oracleClose;

    if (prevClose <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0) {
      continue;
    }

    const logOC = Math.log(open / prevClose);
    overnightVar += logOC * logOC;

    const logCO = Math.log(close / open);
    openCloseVar += logCO * logCO;

    // Rogers-Satchell
    const logHC = Math.log(high / close);
    const logHO = Math.log(high / open);
    const logLC = Math.log(low / close);
    const logLO = Math.log(low / open);
    rsVar += logHC * logHO + logLC * logLO;
  }

  overnightVar /= n;
  openCloseVar /= n;
  rsVar /= n;

  const yzVar = overnightVar + k * openCloseVar + (1 - k) * rsVar;
  return Math.sqrt(yzVar * HOURS_PER_YEAR);
}

/**
 * EMA smoothing for volatility
 */
export function emaSmooth(
  currentVol: number,
  prevEma: number,
  halfLifeHours: number,
  updateIntervalHours: number
): number {
  if (prevEma === 0) return currentVol;
  const alpha = 1 - Math.exp((-Math.LN2 * updateIntervalHours) / halfLifeHours);
  return alpha * currentVol + (1 - alpha) * prevEma;
}

/**
 * Compute full volatility state for a market
 */
export async function computeVolState(
  market: string,
  prevState?: VolState
): Promise<VolState> {
  // Fetch 7 days of hourly candles
  const candles = await fetchCandles(market, "60", 168);

  // Use Yang-Zhang as primary, Parkinson as secondary confirmation
  const yzVol = computeYangZhangVol(candles);
  const pkVol = computeParkinsonVol(candles);

  // Average the two estimators for robustness
  const realizedVol = (yzVol + pkVol) / 2;

  // EMA smoothing
  const ema7d = emaSmooth(
    realizedVol,
    prevState?.emaVol7d ?? 0,
    7 * 24, // 7-day half-life
    1 // 1-hour update interval
  );
  const ema30d = emaSmooth(
    realizedVol,
    prevState?.emaVol30d ?? 0,
    30 * 24, // 30-day half-life
    1
  );

  return {
    realizedVol,
    realizedVolBps: Math.round(realizedVol * 10000),
    emaVol7d: ema7d,
    emaVol30d: ema30d,
    isElevated: ema30d > 0 && realizedVol > 1.5 * ema30d,
    isDepressed: ema30d > 0 && realizedVol < 0.5 * ema30d,
    sampleCount: candles.length,
    lastUpdated: Date.now(),
  };
}
