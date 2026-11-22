// Contest rules: max 3 submissions per market (no edits/retractions), one side per market,
// qualification = 10 judged submissions across >= 3 markets.
import type { QueueItem, Side, State } from "./types.ts";

export const MAX_PER_MARKET = 3;
export const QUAL_JUDGED = 10;
export const QUAL_MARKETS = 3;
export const MAX_FILES = 3;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Slots used on a market: submitted (local or imported) + approved-but-not-yet-sent (reserved). */
export function usedSlots(state: State, market: string): number {
  const subIds = new Set(state.submissions.filter((s) => same(s.market, market)).map((s) => s.id));
  const approved = state.items.filter((i) => same(i.market, market) && i.status === "approved").length;
  const submittedItemsWithoutRecord = state.items.filter(
    (i) => same(i.market, market) && i.status === "submitted" && (!i.submissionId || !subIds.has(i.submissionId)),
  ).length;
  return subIds.size + approved + submittedItemsWithoutRecord;
}

export interface CapCheck {
  ok: boolean;
  used: number;
  remaining: number;
  reason?: string;
}

/** Per-market cap. `remoteRemaining` = EntryState.remainingOnMarket when known (the server is the final word). */
export function capCheck(state: State, market: string, opts: { remoteRemaining?: number; excludingItem?: string } = {}): CapCheck {
  let used = usedSlots(state, market);
  if (opts.excludingItem && state.items.some((i) => i.id === opts.excludingItem && i.status === "approved")) used -= 1;
  let remaining = MAX_PER_MARKET - used;
  if (opts.remoteRemaining !== undefined) remaining = Math.min(remaining, opts.remoteRemaining);
  if (remaining <= 0) return { ok: false, used, remaining: 0, reason: `market cap reached (${used}/${MAX_PER_MARKET} used or reserved)` };
  return { ok: true, used, remaining };
}

/** The side our own drafted note states ("points toward YES|NO"); null for notes we did not write. */
export function sideFromNote(note: string | null): Side | null {
  const m = /points toward (YES|NO)\b/.exec(note ?? "");
  return (m?.[1] as Side | undefined) ?? null;
}

/**
 * The side this market is locked to: explicit lock, else the side of any approved/submitted item,
 * else the side stated in a submission pulled by `sync` (so a lost or fresh state.json still
 * cannot send the opposite side to a market we already argued).
 */
export function lockedSide(state: State, market: string): Side | null {
  const k = Object.keys(state.sides).find((m) => same(m, market));
  if (k) return state.sides[k];
  const it = state.items.find((i) => same(i.market, market) && (i.status === "approved" || i.status === "submitted") && i.side);
  if (it?.side) return it.side;
  for (const s of state.submissions) if (same(s.market, market)) { const sd = sideFromNote(s.note); if (sd) return sd; }
  return null;
}

/** Drop the explicit lock when nothing approved, submitted or synced still argues that side. */
export function releaseSideIfUnused(state: State, market: string): void {
  const holds = state.items.some((i) => same(i.market, market) && (i.status === "approved" || i.status === "submitted"))
    || state.submissions.some((s) => same(s.market, market));
  if (holds) return;
  for (const k of Object.keys(state.sides)) if (same(k, market)) delete state.sides[k];
}

/** Per the FAQ the evidence cutoff is the submission deadline. Unknown cutoff = allowed (server decides). */
export function cutoffCheck(item: Pick<QueueItem, "cutoffAt">, now = Date.now()): { ok: boolean; reason?: string } {
  if (!item.cutoffAt) return { ok: true };
  const t = Date.parse(item.cutoffAt);
  if (Number.isFinite(t) && t <= now) return { ok: false, reason: `market evidence cutoff ${item.cutoffAt} has passed` };
  return { ok: true };
}

export interface SideCheck {
  ok: boolean;
  locked: Side | null;
  reason?: string;
}

/** Part 6: never send evidence for both sides of one market (it cancels out). */
export function sideCheck(state: State, market: string, side: Side | null): SideCheck {
  const locked = lockedSide(state, market);
  if (!side) return { ok: false, locked, reason: "no side set (use set-side)" };
  if (locked && locked !== side) return { ok: false, locked, reason: `market is locked to ${locked}; this item argues ${side}` };
  return { ok: true, locked };
}

export function lockSide(state: State, market: string, side: Side): void {
  if (!lockedSide(state, market)) state.sides[market] = side;
}
