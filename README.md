# ⛈️ Arashi Vault

**Bidirectional funding harvester on Solana.**

Arashi rides the storm — in both directions. A USDC vault that harvests Drift perpetual funding rates by always positioning on the receiving side: SHORT when longs pay shorts, LONG when shorts pay longs. During extreme volatility, idle capital earns lending yield. Capital is never idle — always earning.

## Strategy

Arashi treats funding rate flow as a bidirectional revenue stream:

1. **Compute realized vol** — Yang-Zhang + Parkinson estimators from Drift OHLC data
2. **Determine funding direction** — Positive → SHORT to collect | Negative → LONG to collect
3. **Classify regime** — Scale position size by vol regime (0-40% of equity)
4. **Open position** — Always on the receiving side of funding
5. **Hedge delta** — Regime-aware thresholds: ±5% in calm → ±0.5% in extreme
6. **Flip direction** — When funding changes sign, close and re-enter opposite side

### How It Works

```
User deposits USDC → Voltr Vault
                      └── Arashi Keeper
                           ├── Emergency Monitor (30s)
                           │   ├── Health ratio (close at 1.08)
                           │   └── Drawdown (5% reduce / 8% close)
                           ├── Vol Engine (5 min)
                           │   ├── Yang-Zhang + Parkinson estimators
                           │   └── EMA smoothing (7d / 30d)
                           ├── Funding Direction (10 min)
                           │   ├── Positive → SHORT to collect
                           │   ├── Negative → LONG to collect
                           │   └── |Rate| must exceed cost threshold
                           ├── Regime Detector (2 min)
                           │   ├── 5 regimes → 0-40% sizing
                           │   ├── Pre-extreme wind-down at 65%
                           │   └── Emergency sigma push (2.5σ)
                           ├── Position Manager (2hr rebalance)
                           │   ├── Open in correct funding direction
                           │   ├── Flip direction on sign change
                           │   └── Maker limit orders (postOnly)
                           └── Delta Hedger (regime-aware)
                               └── ±5% calm → ±0.5% extreme
```

### Why Bidirectional

Most vol/basis strategies only SHORT perps — they earn when funding is positive but are forced idle (or lose money) when funding turns negative in bear markets. This creates a structural failure mode.

**Arashi's insight**: Funding flows both ways. When shorts dominate (bear market), LONGS get paid. By always positioning on the receiving side, Arashi earns in ALL market conditions except extreme vol (>75%).

| Market Condition | Funding | Arashi Direction | Revenue Source |
|-----------------|---------|-----------------|---------------|
| Bull (longs dominant) | Positive | **SHORT** | Funding payments |
| Bear (shorts dominant) | Negative | **LONG** | Funding payments |
| Extreme vol | Any | **None** | **Lending yield** (Drift Earn) |

## Architecture

![Arashi Architecture](docs/architecture.svg)

### Components

| Module | File | Purpose |
|--------|------|---------|
| Vol Engine | `src/keeper/vol-engine.ts` | 3 volatility estimators + EMA smoothing |
| Regime Detector | `src/keeper/regime-detector.ts` | 5-regime classification with pre-extreme wind-down |
| Funding Filter | `src/keeper/funding-filter.ts` | Bidirectional funding analysis — determines SHORT or LONG direction |
| Health Monitor | `src/keeper/health-monitor.ts` | 30-second health ratio and drawdown monitoring |
| Delta Hedger | `src/keeper/delta-hedger.ts` | Regime-aware dynamic delta thresholds |
| Vol Trader | `src/keeper/vol-trader.ts` | Bidirectional position management — opens, closes, and flips positions |
| Keeper Loop | `src/keeper/index.ts` | Main event loop with direction flipping logic |
| Vault Setup | `src/scripts/` | Admin scripts to initialize Voltr vault + Drift adaptor |

## 4 Defense Layers

```
Layer 1             Layer 2           Layer 3            Layer 4
Funding Analysis →  Regime Sizing  →  Dynamic Delta  →   Health Monitor
|Rate| > threshold  Vol → 0-40%       ±5% calm           Every 30s
Direction: S or L   10/25/40/20/0     ±0.5% extreme      Close at 1.08
BIDIRECTIONAL       POSITION SCALE    DIRECTIONAL CTRL   LAST DEFENSE
```

## Regime Detection

| Regime | Vol Range | Sizing | Delta ± | Behavior |
|--------|-----------|--------|---------|----------|
| Very Low | < 20% | 10% | ±5% | Minimal — premium thin |
| Low | 20-35% | 25% | ±3% | Moderate |
| Normal | 35-50% | 40% | ±2% | Optimal |
| High | 50-75% | 20% | ±1% | Scale back |
| Pre-Extreme | >65% | 10% | ±1% | Wind-down |
| Extreme | > 75% | 0% | ±0.5% | Full stop |

## Execution

All orders use **maker limit orders** (`postOnly`) for fee rebates:

| | Taker (v1) | Maker (v3) |
|---|---|---|
| Drift fee | 0.035% (pay) | -0.002% (rebate) |
| Round-trip cost | 0.17% | 0.016% |
| Break-even (3-day hold) | 20.7% APY | 1.9% APY |

## Risk Management

| Parameter | Value |
|-----------|-------|
| Max drawdown | 5% reduce / 8% close all |
| Max delta | ±5% to ±0.5% (dynamic by regime) |
| Max leverage | 1.5x |
| Health check | Every 30 seconds |
| Emergency sigma push | 2.5σ move → immediate regime recheck |
| Pre-extreme wind-down | > 65% vol |
| Min |funding| | Must exceed cost threshold |

### Known Limitations

- **Jump risk**: Yang-Zhang assumes continuous prices. Flash crashes cause 1-2 cycle lag (3-6 min). 30s health monitor is last defense.
- **Direction flip cost**: When funding changes sign, the position closes and re-enters opposite side. Maker orders minimize this cost but don't eliminate it.
- **Extreme vol = lending only**: 34% of the backtest period was extreme (no perp positions). Idle USDC earns lending yield via Drift Earn during these periods — capital is never truly idle.

## Backtest Results

32-day backtest (Feb 12 – Mar 15, 2026) — hostile period, 34% extreme vol:

| Metric | v1 (Short only) | v2 (Maker) | v3 (Bidir.) | v3.1 (+Lending) |
|--------|-----------------|-----------|------------|----------------|
| Return | -0.38% | -0.003% | +0.09% | **+0.18%** |
| APY | -4.30% | -0.03% | +1.06% | **+2.09%** |
| Max DD | 0.38% | 0.01% | 0.00% | **0.01%** |
| Sharpe | -10.28 | -0.82 | 9.21 | **15.77** |
| Costs | $424 | $65 | $130 | $125 |
| Revenue sources | 1 | 1 | 1 | **2** |
| Idle earning | $0 | $0 | $0 | **$91 lending** |

**v3.1 ensures capital is never idle.** During the 11 extreme-regime days where previous versions earned nothing, idle USDC now earns lending yield via Drift Earn ($91 over 11 days). Combined with bidirectional funding, Arashi has two revenue sources active in every market condition.

2.09% APY with 34% extreme vol projects to **10-18% APY in normal markets** where the strategy is active 80%+ of the time with higher sizing and both revenue sources contributing.

See [docs/STRATEGY.md](docs/STRATEGY.md) for detailed analysis.

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

Tests validate vol engine, regime detector (updated for v3 sizing), and **bidirectional funding filter** (positive → SHORT, negative → LONG, zero → blocked).

## Demo & Dashboard

- **Pitch video**: `demo/arashi-demo.mp4` — 80-second presentation
- **Live dashboard**: `demo/dashboard.html` — real Drift data, no server needed

```bash
open demo/dashboard.html
open demo/arashi-demo.mp4
```

## Setup

```bash
git clone https://github.com/psyto/arashi.git
cd arashi
npm install
cp .env.example .env
# Edit .env with your RPC URL and keypair paths

npm run admin:init-vault
npm run admin:add-adaptor
npm run manager:init-strategy
npm run keeper
```

## Tech Stack

- **On-chain**: [Voltr Vault](https://docs.ranger.finance) + [Drift Protocol v2](https://docs.drift.trade)
- **Off-chain**: TypeScript keeper with bidirectional funding harvester
- **Data**: [Drift Data API](https://data.api.drift.trade) for OHLC candles, funding rates
- **RPC**: QuickNode (or any Solana RPC provider)

## Hackathon

Built for the [Ranger Build-A-Bear Hackathon](https://ranger.finance/build-a-bear-hackathon) (Mar 9 – Apr 6, 2026).

- **Track**: Main + Drift Side Track
- **Base asset**: USDC
- **Target APY**: 10-18% (normal conditions)
- **Edge**: Bidirectional funding + lending on idle — always earning, never idle
- **Lock period**: 3-month rolling

## License

MIT
