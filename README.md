# ⛈️ Arashi Vault

**Delta-neutral volatility harvesting on Solana.**

Arashi rides the storm. A USDC vault that systematically harvests volatility premium from Drift perpetual markets — earning more when markets are turbulent, pausing when they're extreme. Four defense layers protect capital: funding polarity gate, regime-adaptive sizing, dynamic delta thresholds, and 30-second health monitoring.

## Strategy

Arashi treats volatility as an asset class. The keeper bot computes realized volatility across major Drift perp markets, classifies the current market regime, and sizes positions accordingly:

1. **Compute realized vol** — Yang-Zhang + Parkinson estimators from Drift OHLC data
2. **Check funding polarity** — Hard gate: no entry when funding is negative
3. **Classify regime** — Very Low / Low / Normal / High / Extreme
4. **Size positions** — Larger in Normal (richest risk-adjusted premium), zero in Extreme
5. **Hedge delta** — Regime-aware thresholds: ±5% in calm → ±0.5% in extreme
6. **Collect funding** — Short perp positions earn positive funding as vol premium proxy

### How It Works

```
User deposits USDC → Voltr Vault
                      └── Arashi Keeper
                           ├── Emergency Monitor (30s loop)
                           │   ├── Health ratio check (close at 1.08)
                           │   └── Drawdown check (5% reduce / 8% close)
                           ├── Vol Engine (10 min)
                           │   ├── Fetch hourly candles (168 samples)
                           │   ├── Yang-Zhang + Parkinson estimators
                           │   └── EMA smoothing (7d / 30d)
                           ├── Funding Filter (10 min)
                           │   ├── Hard gate: funding must be > 0
                           │   └── Cost gate: funding > round-trip fees
                           ├── Regime Detector (3 min)
                           │   ├── Classify: veryLow → extreme
                           │   ├── Pre-extreme wind-down at 60%
                           │   └── Pause on rapid transitions
                           ├── Vol Trader (30 min rebalance)
                           │   ├── Size by regime (0-35% of equity)
                           │   └── Short perps on SOL/BTC/ETH
                           └── Delta Hedger (regime-aware)
                               ├── Dynamic threshold: ±5% → ±0.5%
                               └── Tightens with vol regime
```

### Why Volatility Harvesting

In most markets, implied volatility exceeds realized volatility — the "variance risk premium." Short vol strategies systematically capture this premium. On Drift, this manifests as:

- **Positive funding rates** tend to be higher during volatile periods (longs pay more for leverage)
- **Short perp positions** collect this elevated funding as yield
- **Delta hedging** removes directional exposure, isolating the vol premium

Key advantages:
- **Funding polarity gate** — Unlike naive vol strategies, Arashi refuses to enter when funding is negative, preventing the critical failure mode in bear panics
- **Regime-adaptive** — Automatically scales down in dangerous markets
- **Multi-estimator robustness** — Yang-Zhang + Parkinson vol estimates are more efficient than simple close-to-close
- **No options required** — Approximates vol selling using perp funding mechanics

## Architecture

![Arashi Architecture](docs/architecture.svg)

### Components

| Module | File | Purpose |
|--------|------|---------|
| Vol Engine | `src/keeper/vol-engine.ts` | 3 volatility estimators (Yang-Zhang, Parkinson, Close-to-Close) + EMA smoothing |
| Regime Detector | `src/keeper/regime-detector.ts` | 5-regime classification with transition detection and pre-extreme wind-down |
| Funding Filter | `src/keeper/funding-filter.ts` | Funding polarity gate — blocks entry when funding is negative or below cost threshold |
| Health Monitor | `src/keeper/health-monitor.ts` | 30-second health ratio and drawdown monitoring |
| Delta Hedger | `src/keeper/delta-hedger.ts` | Regime-aware dynamic delta thresholds and automated hedging |
| Vol Trader | `src/keeper/vol-trader.ts` | Regime-adaptive position sizing and execution |
| Keeper Loop | `src/keeper/index.ts` | Main event loop — emergency checks, funding gate, vol update, regime, rebalance, hedge |
| Vault Setup | `src/scripts/` | Admin scripts to initialize Voltr vault + Drift adaptor |

## 4 Defense Layers

```
Layer 1          Layer 2           Layer 3            Layer 4
Funding Gate  →  Regime Sizing  →  Dynamic Delta  →   Health Monitor
Rate > 0?        Vol → sizing      ±5% calm           Every 30s
Funding > fees?  0-35% equity      ±0.5% extreme      Close at 1.08
PRIMARY GATE     POSITION SCALE    DIRECTIONAL CTRL   LAST DEFENSE
```

## Volatility Estimators

### Yang-Zhang
Most efficient estimator for drift-adjusted data. Combines overnight returns, open-to-close variance, and Rogers-Satchell intraday component:
```
σ²_YZ = σ²_overnight + k · σ²_open-close + (1-k) · σ²_RS
```

### Parkinson
Uses high-low range for 5× more efficiency per observation than close-to-close:
```
σ² = 1/(4·n·ln2) · Σ(ln(H/L))²
```

### EMA Smoothing
Exponential moving averages with configurable half-lives (7-day and 30-day) detect elevated and depressed vol conditions:
- **Elevated**: Current vol > 1.5× 30-day EMA
- **Depressed**: Current vol < 0.5× 30-day EMA

## Regime Detection

| Regime | Vol Range | Position Sizing | Delta Threshold | Behavior |
|--------|-----------|----------------|-----------------|----------|
| Very Low | < 20% | 5% of equity | ±5% | Minimal — premium too thin |
| Low | 20-35% | 20% | ±3% | Moderate exposure |
| Normal | 35-50% | 35% | ±2% | Optimal — richest risk-adjusted premium |
| High | 50-75% | 15% | ±1% | Significant scale-back |
| Pre-Extreme | 60-75% | 7.5% (50% of high) | ±1% | Wind-down in progress |
| Extreme | > 75% | 0% | ±0.5% | **Full stop** — close all positions |

**Funding polarity gate**: Even in an optimal vol regime, positions are **blocked** if funding is negative. This prevents the critical failure mode where high vol + negative funding = paying to hold a losing position.

The detector also pauses trading on rapid regime transitions (>3 in one hour) — indicating an unstable market where regime classification is unreliable.

## Risk Management

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max drawdown | 5% / 8% severe | Reduce at 5%, close all at 8% |
| Max delta | ±5% to ±0.5% | **Dynamic** — tightens with vol regime |
| Max vega exposure | 10% of equity | Conservative for proxy vol strategy |
| Max leverage | 1.5x | Vol strategies need low leverage |
| Funding gate | Must be positive | **Hard gate** — no entry when funding < 0 |
| Cost gate | Funding > round-trip fees | Prevents fee churn on thin premiums |
| Health ratio warning | 1.15 | Start reducing positions |
| Health ratio critical | 1.08 | Emergency close all |
| Health check interval | 30 seconds | Near real-time monitoring |
| Pre-extreme wind-down | > 60% vol | Halve position sizes before extreme triggers |
| Extreme regime action | Close all | No positions during market crashes |
| Transition pause | >3/hour | Unstable regime → pause |
| Vol update interval | 10 min | Frequent vol computation |
| Regime check interval | 3 min | Fast regime shift detection |
| Rebalance interval | 30 min | Faster reaction |

### What Can Go Wrong

| Risk | Mitigation |
|------|------------|
| High vol + negative funding (bear panic) | **Funding polarity gate** blocks entry — prevents paying to hold a losing position |
| Vol spike beyond extreme threshold | Pre-extreme wind-down at 60% halves positions; 30s health checks catch gaps |
| Delta drift from rapid price moves | Dynamic thresholds tighten with regime (±1% in high vol); 3-min regime checks |
| Prolonged low-vol environment | Minimal 5% sizing preserves capital; cost gate prevents churn |
| Hedging costs exceed returns | Cost gate: funding must exceed round-trip fees (0.17%) over 12h hold |
| Liquidity panic / stop-loss failure | Health monitor at 30s catches margin deterioration; 1.5x max leverage |
| Jump risk (flash crash) | Yang-Zhang is more robust than close-to-close; 30s health monitor is last defense |

**Known limitation**: The Yang-Zhang estimator assumes continuous price paths and struggles with discontinuous jumps (flash crashes). In such events, the regime detector may lag by 1-2 update cycles (3-6 minutes). The 30-second health monitor serves as the last line of defense.

## Backtest Results

32-day backtest (Feb 12 – Mar 15, 2026) using historical Drift data:

| Metric | Value |
|--------|-------|
| Total return | **-0.38%** |
| Max drawdown | **0.38%** (within 5% limit) |
| Trading days | 16/32 (50%) |
| Funding blocked | 5 days (16%) |
| Extreme paused | 11 days (34%) |
| Total costs | $424 (0.42%) |

The backtest period was **hostile** — 34% extreme vol, 16% negative funding. The strategy was idle 50% of the time — this is the cost of safety, not a failure. A naive vol strategy without these controls would have lost far more. In normal conditions (positive funding, 35-50% vol), the strategy targets 10-18% APY.

See [docs/STRATEGY.md](docs/STRATEGY.md) for detailed analysis and known limitations.

## Fees

| Fee | Amount |
|-----|--------|
| Management fee | 1.5% annual |
| Performance fee | 20% of profits |
| Deposit fee | None |
| Withdrawal fee | 0.15% |
| Withdrawal period | 24 hours |

## Testing

**28 unit tests** covering all strategy modules:

```bash
npm test
```

Tests validate:
- **Vol engine** — Parkinson, Close-to-Close, Yang-Zhang estimators, EMA smoothing, edge cases
- **Regime detector** — Classification, aggregate regime, transition detection, pause logic
- **Funding filter** — Polarity gate, minimum threshold, cost gate, zero funding

**Devnet integration tests** validate end-to-end against live Drift:

```bash
npm run test:devnet      # Basic connection + vol engine
node dist/scripts/test-devnet-trading.js  # Full flow with funding filter
```

## Demo & Dashboard

- **Pitch video**: `demo/arashi-demo.mp4` — 80-second presentation (8 slides × 10s) covering 4 defense layers, vol engine, live test results, and backtest
- **Live dashboard**: Open `demo/dashboard.html` in any browser — fetches real Drift OHLC candles, computes vol per market, shows regime classification, funding filter status, and defense layer table. No server required.

```bash
# Preview
open demo/dashboard.html
open demo/arashi-demo.mp4
```

## Setup

### Prerequisites

- Node.js 18+
- Solana CLI
- Funded wallets (SOL for gas, USDC for vault deposits)

### Installation

```bash
git clone https://github.com/psyto/arashi.git
cd arashi
npm install
cp .env.example .env
# Edit .env with your RPC URL and keypair paths
```

### Deploy Vault

```bash
# 1. Initialize Voltr vault
npm run admin:init-vault

# 2. Add Drift adaptor
npm run admin:add-adaptor

# 3. Initialize Drift trading strategy
npm run manager:init-strategy

# 4. Start the keeper bot
npm run keeper
```

## Tech Stack

- **On-chain**: [Voltr Vault](https://docs.ranger.finance) + [Drift Protocol v2](https://docs.drift.trade)
- **Off-chain**: TypeScript keeper bot with custom vol engine and regime detector
- **Data**: [Drift Data API](https://data.api.drift.trade) for OHLC candles, oracle prices, and funding rates
- **RPC**: QuickNode (or any Solana RPC provider)

## Hackathon

Built for the [Ranger Build-A-Bear Hackathon](https://ranger.finance/build-a-bear-hackathon) (Mar 9 – Apr 6, 2026).

- **Track**: Main + Drift Side Track
- **Base asset**: USDC
- **Target APY**: 10-18% (normal vol + positive funding)
- **Lock period**: 3-month rolling

## License

MIT
