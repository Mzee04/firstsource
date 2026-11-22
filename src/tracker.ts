// Part 12: qualification tracker + feedback-bounty log.
import type { FeedbackEntry, State } from "./types.ts";
import { MAX_PER_MARKET, QUAL_JUDGED, QUAL_MARKETS, usedSlots } from "./rules.ts";
import { outcomeOf } from "./learn.ts";

export interface Qualification {
  judged: number;
  judgedMarkets: number;
  pending: number;
  perMarket: { market: string; submitted: number; judged: number; accepted: number; reserved: number; slotsLeft: number }[];
  qualified: boolean;
  needJudged: number;
  needMarkets: number;
}

export function qualification(state: State): Qualification {
  const markets = new Set<string>();
  for (const s of state.submissions) markets.add(s.market.toLowerCase());
  for (const i of state.items) if (i.status === "approved" || i.status === "submitted") markets.add(i.market.toLowerCase());
  const perMarket = [...markets].map((m) => {
    const subs = state.submissions.filter((s) => s.market.toLowerCase() === m);
    const judged = subs.filter((s) => s.status === "judged");
    return {
      market: m,
      submitted: subs.length,
      judged: judged.length,
      accepted: judged.filter((s) => outcomeOf(s) === "accepted").length,
      reserved: state.items.filter((i) => i.market.toLowerCase() === m && i.status === "approved").length,
      slotsLeft: Math.max(0, MAX_PER_MARKET - usedSlots(state, m)),
    };
  });
  const judged = state.submissions.filter((s) => s.status === "judged").length;
  const judgedMarkets = perMarket.filter((p) => p.judged > 0).length;
  const pending = state.submissions.filter((s) => s.status === "queued" || s.status === "judging").length;
  return {
    judged,
    judgedMarkets,
    pending,
    perMarket,
    qualified: judged >= QUAL_JUDGED && judgedMarkets >= QUAL_MARKETS,
    needJudged: Math.max(0, QUAL_JUDGED - judged),
    needMarkets: Math.max(0, QUAL_MARKETS - judgedMarkets),
  };
}

export const FEEDBACK_CATEGORIES = ["bug", "docs", "judge", "api", "ux", "idea"];

export function addFeedback(state: State, category: string, text: string, now = Date.now()): FeedbackEntry {
  if (!FEEDBACK_CATEGORIES.includes(category)) throw new Error(`category must be one of ${FEEDBACK_CATEGORIES.join(", ")}`);
  if (!text.trim()) throw new Error("feedback text is empty");
  const e = { at: new Date(now).toISOString(), category, text: text.trim() };
  state.feedback.push(e);
  return e;
}

export function feedbackMarkdown(state: State): string {
  const by = new Map<string, FeedbackEntry[]>();
  for (const f of state.feedback) by.set(f.category, [...(by.get(f.category) ?? []), f]);
  let md = "# FirstSource feedback log (draft for the feedback bounty; not submitted)\n";
  for (const [c, list] of by) md += `\n## ${c}\n${list.map((f) => `- ${f.at.slice(0, 10)}: ${f.text}`).join("\n")}\n`;
  return md;
}
