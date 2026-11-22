// Part 1: market picker. Prefers uncertain, still-open markets with time left, skips markets
// where we are out of slots, and spreads picks across at least `minMarkets` markets.
import type { MarketCard, State } from "./types.ts";
import { MAX_PER_MARKET, usedSlots } from "./rules.ts";

export const yesProbability = (m: MarketCard): number => (m.odds.yes > 1 ? m.odds.yes / 100 : m.odds.yes);

export interface Pick {
  market: MarketCard;
  score: number;
  uncertainty: number;
  hoursLeft: number;
  slotsLeft: number;
  why: string;
}

export function scoreMarket(m: MarketCard, state: State, now = Date.now()): Pick | null {
  if (String(m.status).toLowerCase() !== "open") return null;
  const cutoff = Date.parse(m.evidenceCutoffAt);
  if (!Number.isFinite(cutoff) || cutoff <= now) return null;
  const p = yesProbability(m);
  if (!(p >= 0 && p <= 1)) return null;
  const slotsLeft = MAX_PER_MARKET - usedSlots(state, m.address);
  if (slotsLeft <= 0) return null;
  const uncertainty = 1 - Math.abs(p - 0.5) * 2; // 1 at 50%, 0 at 0%/100%
  if (uncertainty < 0.4) return null; // outside ~20%..80%, same band as the official starter
  const hoursLeft = (cutoff - now) / 3.6e6;
  const timeW = hoursLeft < 6 ? 0.3 : hoursLeft < 24 ? 0.7 : 1; // too close to cutoff = risky
  const sourceW = m.dataSources?.length ? 1 : 0.8;
  const score = uncertainty * timeW * sourceW;
  return { market: m, score, uncertainty, hoursLeft, slotsLeft, why: `p=${p.toFixed(2)} unc=${uncertainty.toFixed(2)} ${hoursLeft.toFixed(0)}h left, ${slotsLeft} slot(s)` };
}

/** Ranked picks. Guarantees diversity: the first `minMarkets` picks are distinct markets (if available). */
export function pickMarkets(markets: MarketCard[], state: State, opts: { limit?: number; minMarkets?: number; now?: number } = {}): Pick[] {
  const { limit = 8, minMarkets = 3, now = Date.now() } = opts;
  const scored = markets.map((m) => scoreMarket(m, state, now)).filter((x): x is Pick => !!x);
  // Markets we have not touched yet get a small boost, to reach the 3-market qualification bar.
  for (const p of scored) if (usedSlots(state, p.market.address) === 0) p.score *= 1.15;
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: Pick[] = [];
  for (const p of scored) {
    const k = p.market.address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= Math.max(limit, minMarkets)) break;
  }
  return out;
}
