import type { QueueItem, Side, State, SubmissionRecord } from "../src/types.ts";
import { emptyState } from "../src/store.ts";
import { fingerprint } from "../src/novelty.ts";
import { uuidFromSeed } from "../src/text.ts";

let n = 0;
export function item(market: string, text: string, side: Side | null, status: QueueItem["status"] = "pending"): QueueItem {
  const id = `it${++n}`;
  return {
    id, market, question: "Q?", side, status, note: `As of 2026-11-13: ${text}`, links: ["https://example.org/a"], files: [], mode: "link",
    fact: { market, date: "2026-11-13", text, source: "https://example.org/a", sourceKind: "official", publisher: "example.org", fetchedAt: "2026-11-20T00:00:00Z", relevance: 1 },
    sideCall: { side, confidence: side ? "medium" : "none", reason: "test" },
    preflight: { url: "https://example.org/a", checkedAt: "2026-11-20T00:00:00Z", readable: true, textLength: 1000, keyTextFound: true, reasons: [] },
    idempotencyKey: uuidFromSeed(id), fingerprint: fingerprint(text), createdAt: "2026-11-20T00:00:00Z", dryRuns: [],
  };
}

export function sub(market: string, status: string, extra: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return { id: `s${++n}`, market, itemId: null, note: `note ${n}`, links: ["https://example.org/x"], status, verdict: null, reason: null, bounty: null, createdAt: "2026-11-25T18:00:00Z", updatedAt: "2026-11-25T18:00:00Z", ...extra };
}

export function state(): State {
  return emptyState();
}
