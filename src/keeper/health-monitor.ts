import { DriftClient } from "@drift-labs/sdk";
import { STRATEGY_CONFIG } from "../config/vault";

export interface HealthState {
  totalCollateral: number;
  maintenanceMargin: number;
  healthRatio: number;
  unrealizedPnl: number;
  status: "healthy" | "warning" | "critical" | "liquidatable";
  action: "none" | "reduce" | "close_all";
}

/**
 * Monitor Drift account health ratio every 30 seconds.
 *
 * For a vol strategy, health ratio deterioration is more dangerous
 * than for basis trades because:
 * 1. Vol strategies hold positions during turbulent markets
 * 2. Delta can drift between hedges, creating directional exposure
 * 3. Extreme vol events cause correlated losses across all positions
 */
export function computeHealthState(driftClient: DriftClient): HealthState {
  const user = driftClient.getUser();

  const totalCollateral = user.getTotalCollateral().toNumber() / 1e6;
  const maintenanceMargin =
    user.getMaintenanceMarginRequirement().toNumber() / 1e6;
  const unrealizedPnl = user.getUnrealizedPNL(true).toNumber() / 1e6;

  const healthRatio =
    maintenanceMargin > 0 ? totalCollateral / maintenanceMargin : Infinity;

  let status: HealthState["status"];
  let action: HealthState["action"];

  if (healthRatio <= 1.0) {
    status = "liquidatable";
    action = "close_all";
  } else if (healthRatio <= STRATEGY_CONFIG.criticalHealthRatio) {
    status = "critical";
    action = "close_all";
  } else if (healthRatio <= STRATEGY_CONFIG.minHealthRatio) {
    status = "warning";
    action = "reduce";
  } else {
    status = "healthy";
    action = "none";
  }

  return {
    totalCollateral,
    maintenanceMargin,
    healthRatio,
    unrealizedPnl,
    status,
    action,
  };
}

export function computeDrawdown(
  currentEquity: number,
  peakEquity: number
): { drawdownPct: number; action: "none" | "reduce" | "close_all" } {
  if (peakEquity <= 0) return { drawdownPct: 0, action: "none" };

  const drawdownPct = ((peakEquity - currentEquity) / peakEquity) * 100;

  if (drawdownPct >= STRATEGY_CONFIG.severeDrawdownPct) {
    return { drawdownPct, action: "close_all" };
  }
  if (drawdownPct >= STRATEGY_CONFIG.maxDrawdownPct) {
    return { drawdownPct, action: "reduce" };
  }
  return { drawdownPct, action: "none" };
}
