# ⛈️ Arashi Vault

**Delta-neutral volatility harvesting on Solana.**

Arashi rides the storm. A USDC vault that systematically harvests volatility premium from Drift perpetual markets — earning more when markets are turbulent, pausing when they're extreme.

## Strategy

Arashi treats volatility as an asset class. The keeper bot computes realized volatility across major Drift perp markets, classifies the current market regime, and sizes positions accordingly:

1. **Compute realized vol** — Yang-Zhang + Parkinson estimators from Drift OHLC data
2. **Classify regime** — Very Low / Low / Normal / High / Extreme
3. **Size positions** — Larger in Normal (richest risk-adjusted premium), zero in Extreme
4. **Hedge delta** — Maintain delta-neutral via Drift perp hedges
5. **Collect funding** — Short perp positions earn positive funding as vol premium proxy

### How It Works

```
User deposits USDC → Voltr Vault
                      └── Arashi Keeper
                           ├── Vol Engine
                           │   ├── Fetch hourly candles (168 samples)
                           │   ├── Yang-Zhang estimator
                           │   ├── Parkinson estimator
                           │   └── EMA smoothing (7d / 30d)
                           ├── Regime Detector
                           │   ├── Classify: veryLow → extreme
                           │   ├── Detect transitions
                           │   └── Pause on extreme / rapid shifts
                           ├── Vol Trader
                           │   ├── Size by regime (0-50% of equity)
                           │   └── Short perps on SOL/BTC/ETH
                           └── Delta Hedger
                               ├── Compute portfolio delta
                               └── Rehedge when |delta| > ±5%
```

### Why Volatility Harvesting

In most markets, implied volatility exceeds realized volatility — the "variance risk premium." Short vol strategies systematically capture this premium. On Drift, this manifests as:

- **Positive funding rates** tend to be higher during volatile periods (longs pay more for leverage)
- **Short perp positions** collect this elevated funding as yield
- **Delta hedging** removes directional exposure, isolating the vol premium

Key advantages:
- **Countercyclical to basis trades** — Performs best when traditional strategies struggle
- **Regime-adaptive** — Automatically scales down in dangerous markets
- **Multi-estimator robustness** — Yang-Zhang + Parkinson vol estimates are more efficient than simple close-to-close
- **No options required** — Approximates vol selling using perp funding mechanics

## Architecture

```
┌─────────────────────────────────────┐
│  Voltr Vault (on-chain)             │
│  Deposits, withdrawals, LP shares   │
├─────────────────────────────────────┤
│  Drift Adaptor (on-chain)           │
│  Bridges vault ↔ Drift protocol     │
├─────────────────────────────────────┤
│  Arashi Keeper Bot (off-chain)      │
│  ├── Vol Engine                     │
│  │   ├── Yang-Zhang estimator       │
│  │   ├── Parkinson estimator        │
│  │   └── EMA smoothing              │
│  ├── Regime Detector                │
│  │   ├── 5 regime classifications   │
│  │   ├── Transition detection       │
│  │   └── Rapid-shift pause logic    │
│  ├── Vol Trader                     │
│  │   ├── Regime-based sizing        │
│  │   └── Position management        │
│  └── Delta Hedger                   │
│       ├── Portfolio Greeks           │
│       └── Automated rehedging       │
└─────────────────────────────────────┘
```

### Components

| Module | File | Purpose |
|--------|------|---------|
| Vol Engine | `src/keeper/vol-engine.ts` | 3 volatility estimators + EMA smoothing |
| Regime Detector | `src/keeper/regime-detector.ts` | 5-regime classification with transition detection |
| Delta Hedger | `src/keeper/delta-hedger.ts` | Portfolio delta computation and automated hedging |
| Vol Trader | `src/keeper/vol-trader.ts` | Regime-adaptive position sizing and execution |
| Keeper Loop | `src/keeper/index.ts` | Main event loop — vol update, regime check, rebalance, hedge |
| Vault Setup | `src/scripts/` | Admin scripts to initialize Voltr vault + Drift adaptor |

## Volatility Estimators

### Yang-Zhang
The most efficient estimator for drift-adjusted data. Combines overnight returns, open-to-close variance, and Rogers-Satchell intraday component:

```
σ²_YZ = σ²_overnight + k · σ²_open-close + (1-k) · σ²_RS
```

### Parkinson
Uses high-low range for higher efficiency than close-to-close with the same number of observations:

```
σ² = 1/(4·n·ln2) · Σ(ln(H/L))²
```

### EMA Smoothing
Exponential moving averages with configurable half-lives (7-day and 30-day) detect elevated and depressed vol conditions:
- **Elevated**: Current vol > 1.5× 30-day EMA
- **Depressed**: Current vol < 0.5× 30-day EMA

## Regime Detection

| Regime | Vol Range | Position Sizing | Behavior |
|--------|-----------|----------------|----------|
| Very Low | < 20% | 10% of equity | Small positions — low premium available |
| Low | 20-35% | 30% | Moderate exposure |
| Normal | 35-50% | 50% | Optimal — richest risk-adjusted premium |
| High | 50-75% | 30% | Scale back — rising risk |
| Extreme | > 75% | 0% | **Full stop** — close all positions |

The detector also pauses trading on rapid regime transitions (>3 in one hour) — indicating an unstable market where regime classification is unreliable.

## Risk Management

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max drawdown | 8% | Closes all positions if breached |
| Max delta | ±5% | Rehedge trigger — maintains neutrality |
| Max vega exposure | 15% of equity | Limits vol sensitivity |
| Max leverage | 3x | Conservative for vol strategies |
| Extreme regime action | Close all | No positions during market crashes |
| Transition pause | >3/hour | Unstable regime detection → pause |
| Vol update interval | 15 min | Frequent vol computation |
| Regime check interval | 5 min | Fast regime shift detection |
| Rebalance interval | 1 hour | Position adjustment frequency |

### What Can Go Wrong

| Risk | Mitigation |
|------|------------|
| Vol spike beyond extreme threshold | Automatic position closure at extreme regime |
| Delta drift from rapid price moves | 5-minute regime checks + hourly rehedge |
| Prolonged low-vol environment | Minimal 10% sizing preserves capital while collecting small premium |
| Funding rate inversion | Exit positions when funding turns negative |
| Cascading liquidations on Drift | Max 3x leverage with regime-adaptive scaling |

## Fees

| Fee | Amount |
|-----|--------|
| Management fee | 1.5% annual |
| Performance fee | 20% of profits |
| Deposit fee | None |
| Withdrawal fee | 0.15% |
| Withdrawal period | 24 hours |

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
# Edit .env with your keypair paths and RPC URL
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

### Development

```bash
# Build TypeScript
npm run build

# Run devnet tests
npm run test:devnet

# Watch mode
npm run keeper:dev
```

## Tech Stack

- **On-chain**: [Voltr Vault](https://docs.ranger.finance) + [Drift Protocol v2](https://docs.drift.trade)
- **Off-chain**: TypeScript keeper bot with custom vol engine
- **Data**: [Drift Data API](https://data.api.drift.trade) for OHLC candles and oracle prices
- **RPC**: Helius

## Hackathon

Built for the [Ranger Build-A-Bear Hackathon](https://ranger.finance/build-a-bear-hackathon) (Mar 9 – Apr 6, 2026).

- **Track**: Main + Drift Side Track
- **Base asset**: USDC
- **Target APY**: 12-20% in normal+ vol regimes
- **Lock period**: 3-month rolling

## License

MIT
