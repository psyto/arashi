# Arashi Vault — Strategy Documentation

## Thesis

Volatility is mispriced in crypto perpetual markets. During turbulent periods, leveraged traders pay elevated funding rates to maintain their positions — creating a systematic premium that can be harvested by short perp positions. Arashi captures this premium while maintaining delta-neutrality through regime-adaptive controls.

**Core insight**: The correlation between "high volatility" and "high funding rates" holds in bull markets but breaks down in panic-driven bear markets where funding turns negative. Arashi addresses this by making **funding polarity the primary entry gate** — not volatility alone. Vol determines sizing; funding determines whether to trade at all.

**Critical distinction**: "Short perp = vol selling" is an approximation that fails in specific regimes. Arashi acknowledges this limitation and implements a multi-layer defense: funding filter → regime sizing → dynamic delta thresholds → health monitoring → emergency shutdown.

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
├── Funding Polarity Filter (HARD GATE)
│   ├── Funding rate > 0? If no → BLOCK ENTRY regardless of vol
│   └── Funding > round-trip costs? If no → BLOCK ENTRY
│
├── Regime Classification
│   ├── Very Low  (< 20%)  →  5% sizing, ±5% delta
│   ├── Low       (20-35%) → 20% sizing, ±3% delta
│   ├── Normal    (35-50%) → 35% sizing, ±2% delta ← optimal
│   ├── High      (50-75%) → 15% sizing, ±1% delta
│   ├── Pre-Extreme (>60%) → 50% of high sizing (wind-down)
│   └── Extreme   (> 75%)  →  0% sizing, ±0.5% delta ← full stop
│
├── Position Sizing + Trade Execution
│   ├── Open short perps scaled to regime × leverage cap (1.5x max)
│   └── Only if funding gate AND regime gate both pass
│
└── Delta Hedge (regime-aware thresholds)
    ├── Tightens as vol rises: ±5% (calm) → ±0.5% (extreme)
    └── Rehedge on SOL-PERP (most liquid)
```

### Vol Selling Mechanics

Arashi approximates volatility selling using Drift perpetual futures:

1. **Short perp positions** collect positive funding (the "vol premium")
2. **Delta hedging** via offsetting perp positions removes directional exposure
3. **Regime-based sizing** increases exposure when the premium is richest (Normal regime)
4. **Funding filter** prevents entry when the vol→funding correlation breaks down

This avoids the need for on-chain options markets (which don't exist on Solana at scale) while capturing similar economics.

**Acknowledged limitation**: This proxy breaks in bear panic markets where vol is high but funding is negative (shorts pay longs). The funding polarity gate prevents this failure mode, but it also means Arashi sits in cash during some high-vol periods — accepting missed opportunity in exchange for avoiding catastrophic loss.

### Why Two Volatility Estimators

| Estimator | Strength | Weakness |
|-----------|----------|----------|
| **Parkinson (High-Low)** | 5× more efficient per observation | Assumes no drift; sensitive to wicks |
| **Yang-Zhang** | Most efficient, handles drift + overnight gaps | Struggles with discontinuous jumps (flash crashes) |

Arashi averages both for robustness. Neither handles jump risk well — the 30-second health monitor serves as the last line of defense for gap events.

## Risk Management

### Funding Polarity Filter (Highest Priority)

The primary entry condition is **positive funding**, not volatility. This addresses the critical failure mode:

> "In panic-driven bear markets, funding rates often turn deeply negative. The strategy would incorrectly maintain a short position due to high volatility, resulting in continuous capital drain through negative carry."

| Check | Threshold | Action if Failed |
|-------|-----------|-----------------|
| Funding rate sign | Must be > 0 | Block entry, close existing position |
| Funding rate magnitude | > 0.01% per hour | Block entry (too thin) |
| Funding vs costs | Expected funding > 0.17% round-trip costs over 12h | Block entry (unprofitable) |

### Position Sizing by Regime

| Regime | Vol (annualized) | Sizing | Delta Threshold | Rationale |
|--------|-----------------|--------|-----------------|-----------|
| Very Low | < 20% | 5% | ±5% | Premium too thin |
| Low | 20-35% | 20% | ±3% | Moderate premium |
| Normal | 35-50% | **35%** | ±2% | Optimal risk/reward |
| High | 50-75% | 15% | ±1% | Scale back — tail risk rising |
| Pre-Extreme | 60-75% | 7.5% | ±1% | Wind-down before crash |
| Extreme | > 75% | **0%** | ±0.5% | Full shutdown |

### Dynamic Delta Thresholds

Addresses the critique: *"±5% delta is too loose — effectively a directional gamble in disguise."*

Delta thresholds now tighten with volatility:
- **Low vol**: ±5% is acceptable — hedging is cheap, delta drift has limited impact
- **Normal vol**: ±2% — tighter control, vol premium is fragile if directional
- **High vol**: ±1% — any delta exposure is a gamble during turbulence
- **Extreme**: ±0.5% — near-zero tolerance

### Pre-Extreme Wind-Down

Addresses the critique: *"By that instant, price has already gapped."*

Instead of waiting for the 75% extreme threshold to trigger a full close (which may arrive too late with gapped prices), Arashi begins winding down at **60% realized vol** — halving position sizes while liquidity is still available.

### Health Ratio Monitoring

| Level | Health Ratio | Action | Check Interval |
|-------|-------------|--------|----------------|
| Healthy | > 1.15 | Normal operation | 30 seconds |
| Warning | 1.08 – 1.15 | Reduce positions | 30 seconds |
| Critical | < 1.08 | Emergency close all | 30 seconds |
| Liquidatable | < 1.0 | Drift liquidates | Should never reach |

The 30-second monitoring cycle is the **last line of defense** for jump risk and flash crashes that the vol estimators cannot anticipate.

### Drawdown Limits

| Trigger | Action |
|---------|--------|
| 5% drawdown | Reduce positions — close weakest |
| 8% drawdown | Emergency close all |
| Extreme regime | Close all immediately |
| >3 regime transitions per hour | Pause — market too unstable |

### Vega Exposure

- Max **10%** of equity exposed to vega
- Prevents blowup from sudden vol expansion beyond model assumptions
- Lower cap than typical (10% vs 15%) to account for the proxy nature of perp funding as vol premium

### What We Don't Do

- **No entry when funding is negative** — Hard gate, regardless of vol signal
- **No naked short gamma** — All positions delta-hedged with regime-aware thresholds
- **No leverage looping** — Max 1.5x leverage, no recursive borrowing
- **No DEX LP** — No impermanent loss
- **No illiquid markets** — Only SOL, BTC, ETH perps
- **No holding through extreme vol** — Pre-emptive wind-down at 60%, full shutdown at 75%
- **No fixed delta threshold** — Tightens dynamically with regime

## Expected Returns

| Market Condition | Realized Vol | Funding | Leverage | Expected APY | Behavior |
|-----------------|-------------|---------|----------|-------------|----------|
| Low vol, positive funding | < 35% | Positive | 1.5x | 5-10% | Small positions, modest premium |
| Normal vol, positive funding | 35-50% | Positive | 1.5x | **10-18%** | Optimal regime |
| High vol, positive funding | 50-75% | Positive | 1.5x | 8-12% | Scaled back |
| High vol, negative funding | 50-75% | **Negative** | 0x | 0% (cash) | **Funding gate blocks entry** |
| Extreme vol | > 75% | Any | 0x | 0% (cash) | Full shutdown |

**Key insight**: The "high vol + negative funding" scenario is where naive vol strategies blow up. Arashi explicitly handles this by making funding the primary gate — accepting 0% return to avoid catastrophic loss.

## Backtest Results (Feb 12 – Mar 15, 2026)

32-day backtest comparing v1 (taker orders) and v2 (maker limit orders):

| Metric | v1 (Taker) | v2 (Maker) |
|--------|-----------|-----------|
| Starting equity | $100,000 | $100,000 |
| Ending equity | $99,623 | **$99,997** |
| Total return | -0.38% | **-0.003%** |
| Annualized APY | -4.30% | **-0.03%** |
| Max drawdown | 0.38% | **0.01%** |
| Total costs | $424 | **$65** (-85%) |
| Trading days | 16/32 (50%) | 17/32 (53%) |

**Regime breakdown**: Normal 22%, High 44%, Extreme 34%.

**What changed in v2**: Switched to maker limit orders (-0.002% rebate) for both trades and delta hedges. Raised regime sizing (10/25/40/20/0 from 5/20/35/15/0). Added emergency sigma push for faster regime detection.

**v2 nearly eliminated all losses** in the same hostile period. The $3 total loss on $100K represents near-perfect capital preservation. Hedge costs dropped from $352 to $53 because maker orders earn rebates instead of paying fees.

**What the backtest proves**: Even in the worst environment (34% extreme vol, 13% negative funding, 47% idle), Arashi's defense layers plus maker execution preserve capital almost perfectly. The -0.003% return is not "capital stagnation" — it is the cost of surviving a market where naive strategies would have lost significantly more.

**In normal conditions** (positive funding, 35-50% vol, active 80%+), v2 targets 10-18% APY with 40% regime sizing, 1.5x leverage, and maker rebates contributing to returns rather than draining them.

## Markets Traded

| Market | Why |
|--------|-----|
| SOL-PERP | Most liquid Drift market, primary hedge instrument |
| BTC-PERP | Highest OI globally, deepest order book on Drift |
| ETH-PERP | Second most liquid, structural long demand |

Only three markets — sufficient for vol estimation while maintaining deep liquidity for hedging. Avoids illiquid altcoins where stop-losses fail.

## Known Limitations

1. **Jump risk**: The Yang-Zhang estimator assumes continuous price paths. Flash crashes create discontinuities that the model detects with 1-2 cycle lag (3-6 minutes). The 30-second health monitor partially mitigates this.

2. **Vol→funding correlation breakdown**: In bear panics, high vol does not produce high positive funding. The funding gate handles this, but Arashi sits idle during these periods — missing potential recovery trades.

3. **Solana network congestion**: During extreme events, Solana block production can slow. Keeper transactions may fail or delay, preventing timely hedges. Max 1.5x leverage provides a buffer.

4. **Drift order book depth**: During liquidation cascades, Drift's vAMM spread widens. Market order hedges may execute at worse prices than estimated. The 0.05% slippage assumption in the cost gate may be insufficient during true crises.

## Implementation Details

### Keeper Architecture

```
Main Loop (30-second tick)
├── Every 30s:  Emergency checks (health ratio + drawdown)
├── Every 3m:   Regime check (fast response to shifts)
├── Every 10m:  Vol engine update + funding polarity check
├── Every 30m:  Full rebalance cycle
│   ├── Apply funding gate per market
│   ├── Apply pre-extreme wind-down if vol > 60%
│   ├── Compute target sizing from regime
│   ├── Open/close vol positions
│   └── Compute and execute delta hedges (regime-aware thresholds)
└── Every 30s:  Heartbeat log (equity, regime, positions, delta)
```

### Technology

- **Vault**: Voltr (Ranger Earn) — deposits, LP shares, fee collection
- **Trading**: Drift Protocol v2 — perp execution and funding collection
- **Vol Engine**: Custom TypeScript — Yang-Zhang + Parkinson estimators
- **Regime Detection**: 5-level classification with pre-extreme wind-down
- **Funding Filter**: Polarity gate + cost gate
- **Data**: Drift Data API — OHLC candles, oracle prices, funding rates
- **RPC**: QuickNode

### Execution Flow

1. **Deposit**: User deposits USDC → Voltr vault mints LP tokens
2. **Vol Computation**: Keeper fetches 168 hourly candles per market
3. **Funding Check**: Is funding positive and above cost threshold?
4. **Regime Classification**: Aggregate vol → regime → position size + delta threshold
5. **Trade Execution**: Short perps (if funding gate AND regime gate pass)
6. **Delta Hedge**: Compute portfolio delta, hedge if exceeding regime-based threshold
7. **Funding Collection**: Positions accumulate hourly funding payments
8. **Health Monitoring**: 30-second checks for margin and drawdown
9. **NAV Update**: Vault NAV reflects Drift account equity
10. **Withdrawal**: User requests → 24h cooldown → receives USDC
