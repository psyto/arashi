# Arashi Vault — Strategy Documentation

## Thesis

Volatility is mispriced in crypto perpetual markets. During turbulent periods, leveraged traders pay elevated funding rates to maintain their positions — creating a systematic premium that can be harvested by short perp positions. Arashi captures this premium while maintaining delta-neutrality, using a custom volatility engine and regime detector to size positions adaptively.

**Core insight**: Funding rates are a proxy for implied volatility. When markets are volatile, longs pay more to maintain leverage, and shorts collect elevated yield. Arashi treats this as a systematic vol premium and applies institutional-grade risk controls — including automatic shutdown during extreme regimes.

## How It Works

### Signal Pipeline

```
Drift OHLC Candles (168 hourly samples)
│
├── Yang-Zhang Estimator ─┐
│                         ├── Average → Realized Vol
├── Parkinson Estimator ──┘
│
├── EMA Smoothing
│   ├── 7-day half-life → Short-term trend
│   └── 30-day half-life → Long-term baseline
│
├── Regime Classification
│   ├── Very Low  (< 20%)  → 10% sizing
│   ├── Low       (20-35%) → 30% sizing
│   ├── Normal    (35-50%) → 50% sizing ← optimal
│   ├── High      (50-75%) → 30% sizing
│   └── Extreme   (> 75%)  → 0% sizing ← full stop
│
└── Position Sizing + Delta Hedge
    ├── Open short perps scaled to regime
    ├── Monitor portfolio delta every hour
    └── Rehedge when |delta| > ±5% of notional
```

### Vol Selling Mechanics

Arashi approximates volatility selling using Drift perpetual futures:

1. **Short perp positions** collect positive funding (the "vol premium")
2. **Delta hedging** via offsetting perp positions removes directional exposure
3. **Regime-based sizing** increases exposure when the premium is richest (Normal regime) and eliminates it when risk overwhelms reward (Extreme)

This avoids the need for on-chain options markets (which don't exist on Solana at scale) while capturing similar economics.

### Why Three Volatility Estimators

| Estimator | Strength | Weakness |
|-----------|----------|----------|
| **Close-to-Close** | Simple, intuitive | Ignores intraday information |
| **Parkinson (High-Low)** | 5× more efficient per observation | Assumes no drift |
| **Yang-Zhang** | Most efficient, handles drift + overnight gaps | Computationally heavier |

Arashi averages Yang-Zhang and Parkinson for robustness. If one estimator is biased by market structure (e.g., wicks vs closes), the average reduces estimation error.

## Risk Management

### Position Sizing by Regime

| Regime | Vol (annualized) | Sizing | Rationale |
|--------|-----------------|--------|-----------|
| Very Low | < 20% | 10% | Premium too thin to justify risk |
| Low | 20-35% | 30% | Moderate premium, moderate risk |
| Normal | 35-50% | **50%** | Optimal risk/reward — richest premium relative to realized moves |
| High | 50-75% | 30% | Premium rising but tail risk increasing faster |
| Extreme | > 75% | **0%** | Shut down — gamma risk exceeds any premium |

### Delta Management

- Portfolio delta computed from all active perp positions
- Rehedge triggered when `|net delta| > 5%` of total notional
- Hedge instrument: SOL-PERP (most liquid Drift market)
- Hedges are market orders for immediate execution

### Drawdown Limits

| Trigger | Action |
|---------|--------|
| 8% drawdown | Close all positions, pause trading |
| Extreme regime | Close all positions immediately |
| >3 regime transitions per hour | Pause — market too unstable for regime classification |

### Vega Exposure

- Max 15% of equity exposed to vega (vol sensitivity)
- Prevents blowup from sudden vol expansion beyond expectations
- Vega approximated from position size and time to next funding settlement

### What We Don't Do

- **No naked short gamma** — All positions are hedged delta-neutral
- **No leverage looping** — Max 3x leverage, no recursive borrowing
- **No DEX LP** — No impermanent loss
- **No illiquid markets** — Only SOL, BTC, ETH perps (highest liquidity on Drift)
- **No holding through extreme vol** — Automatic shutdown above 75% realized vol

## Expected Returns

| Market Condition | Realized Vol | Expected APY | Behavior |
|-----------------|-------------|-------------|----------|
| Low vol (calm markets) | < 35% | 5-10% | Small positions, modest premium |
| Normal vol | 35-50% | **12-20%** | Optimal regime — richest risk-adjusted premium |
| High vol | 50-75% | 10-15% | Elevated premium but scaled back sizing |
| Extreme vol | > 75% | 0% (cash) | No positions — capital preservation |

**Arashi is countercyclical to basis trade strategies.** When funding compresses in calm markets (hurting Kuma), Arashi also earns less. But when markets are turbulent and funding spikes, Arashi captures elevated premium while remaining hedged.

## Markets Traded

| Market | Why |
|--------|-----|
| SOL-PERP | Most liquid Drift market, primary hedge instrument |
| BTC-PERP | Highest OI globally, richest funding data |
| ETH-PERP | Second most liquid, structural long demand from stakers |

These three markets provide sufficient diversification while maintaining deep liquidity for hedging.

## Implementation Details

### Keeper Architecture

```
Main Loop (60s tick)
├── Every 5 min:  Regime check (fast response to shifts)
├── Every 15 min: Vol engine update (recompute realized vol)
├── Every 1 hour: Full rebalance cycle
│   ├── Check drawdown limits
│   ├── Compute target sizing from regime
│   ├── Open/close vol positions
│   └── Compute and execute delta hedges
└── Every tick:   Heartbeat log
```

### Technology

- **Vault**: Voltr (Ranger Earn) — deposits, LP shares, fee collection
- **Trading**: Drift Protocol v2 — perp execution and funding collection
- **Vol Engine**: Custom TypeScript — Yang-Zhang + Parkinson estimators
- **Regime Detection**: Ported from Vigil signal detector patterns
- **Data**: Drift Data API — OHLC candles, oracle prices
- **RPC**: Helius

### Execution Flow

1. **Deposit**: User deposits USDC → Voltr vault mints LP tokens
2. **Vol Computation**: Keeper fetches 168 hourly candles per market
3. **Regime Classification**: Aggregate vol → regime → position size target
4. **Trade Execution**: Short perps on Drift proportional to regime sizing
5. **Delta Hedge**: Compute portfolio delta, hedge if |delta| > 5%
6. **Funding Collection**: Positions accumulate hourly funding payments
7. **NAV Update**: Vault NAV reflects Drift account equity
8. **Withdrawal**: User requests → 24h cooldown → receives USDC

### Monitoring

- Vol state logged per market every 15 minutes (realized, EMA7d, EMA30d)
- Regime transitions logged with signals and confidence
- Delta exposure logged every rebalance cycle
- Pause events logged with reason (extreme regime, rapid transitions)
