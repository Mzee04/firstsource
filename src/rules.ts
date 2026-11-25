// Contest rules from the official Evidence API / competition docs (skill.md, evidence-api.md):
// max 3 submissions per market (1 on Restricted; the server is the final word), no edits,
// one side per market, qualification = 10 judged submissions (verdict other than
// manipulation) across >= 3 markets. A submission holds at most 3 items in total:
// the note, each link and each file count as 1.
import fs from "node:fs";
import path from "node:path";
import type { QueueItem, Side, State, SubmissionRecord } from "./types.ts";

export const MAX_PER_MARKET = 3;
export const QUAL_JUDGED = 10;
export const QUAL_MARKETS = 3;
/** Hard cap on files alone; the tighter rule is MAX_ITEMS across note + links + files. */
export const MAX_FILES = 3;
export const MAX_ITEMS = 3;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 20;
export const NOTE_CHAR_MAX = 8_000;

/** Official count: the note (if non-empty), each link and each file is 1 item. */
export function itemCount(note: string | null | undefined, links: readonly string[] = [], files: readonly string[] = []): number {
  return (note && note.trim() ? 1 : 0) + links.length + files.length;
}

export function itemsCheck(note: string | null | undefined, links: readonly string[] = [], files: readonly string[] = []): { ok: boolean; count: number; reason?: string } {
  const count = itemCount(note, links, files);
  if (count > MAX_ITEMS) {
    return { ok: false, count, reason: `max ${MAX_ITEMS} items per submission (the note, each link and each file count as 1; this bundle has ${count})` };
  }
  if (count < 1) return { ok: false, count, reason: "a submission needs at least one of: a note, a link, or a file" };
  return { ok: true, count };
}

/** Count /Type /Page (not /Pages) in a PDF; undefined if it does not look like a PDF. */
export function pdfPageCount(file: string): number | undefined {
  if (path.extname(file).toLowerCase() !== ".pdf") return undefined;
  try {
    const buf = fs.readFileSync(file);
    if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF-")) return undefined;
    const n = (buf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) || []).length;
    return n || undefined;
  } catch {
    return undefined;
  }
}

export function filesCheck(files: readonly string[]): { ok: boolean; reason?: string } {
  let bytes = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) return { ok: false, reason: `file missing ${f}` };
    const st = fs.statSync(f);
    if (!st.isFile() || st.size === 0) return { ok: false, reason: `file ${f} is empty or not a regular file` };
    bytes += st.size;
    const pages = pdfPageCount(f);
    if (pages !== undefined && pages > MAX_PDF_PAGES) {
      return { ok: false, reason: `${path.basename(f)} has ${pages} PDF pages (max ${MAX_PDF_PAGES})` };
    }
  }
  if (bytes > MAX_FILE_BYTES) return { ok: false, reason: `attachments total ${bytes} bytes (max ${MAX_FILE_BYTES})` };
  return { ok: true };
}

/** A judged `duplicate` verdict gives its per-market slot back (official 2026-11-25 rule). A status `rejected` with code duplicate still counts. */
export function countsTowardMarketCap(s: SubmissionRecord): boolean {
  if (s.status === "judged" && (s.verdict ?? "").trim().toLowerCase() === "duplicate") return false;
  return true;
}

/** Prize minimum: judged submissions whose verdict is not `manipulation`. */
export function countsTowardQualification(s: SubmissionRecord): boolean {
  if (s.status !== "judged") return false;
  const v = (s.verdict ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  return v !== "manipulation";
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Slots used on a market: submitted (local or imported) + approved-but-not-yet-sent (reserved). */
export function usedSlots(state: State, market: string): number {
  const subIds = new Set(state.submissions.filter((s) => same(s.market, market) && countsTowardMarketCap(s)).map((s) => s.id));
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
export function capCheck(state: State, market: string, opts: { remoteRemaining?: number; excludingItem?: string; perMarket?: number } = {}): CapCheck {
  const max = opts.perMarket ?? MAX_PER_MARKET;
  let used = usedSlots(state, market);
  if (opts.excludingItem && state.items.some((i) => i.id === opts.excludingItem && i.status === "approved")) used -= 1;
  let remaining = max - used;
  if (opts.remoteRemaining !== undefined) remaining = Math.min(remaining, opts.remoteRemaining);
  if (remaining <= 0) return { ok: false, used, remaining: 0, reason: `market cap reached (${used}/${max} used or reserved)` };
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

/** The official docs: evidence cutoff is the submission deadline, usually 24h before close; use the market's cutoff field. Unknown cutoff = allowed (server decides). */
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
