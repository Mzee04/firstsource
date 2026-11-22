// Part 5: novelty filter. A fact is "not new" if its fingerprint (normalized text, dates in ISO)
// or a near-duplicate (same numbers + >=80% token overlap) already exists in our queue, our
// submissions, or the notes returned by listSubmissions. Same-market duplicates block; a
// duplicate on another market is reported as a warning.
import type { State } from "./types.ts";
import { sha256, tokens } from "./text.ts";

export function fingerprint(text: string): string {
  return sha256(tokens(text).join(" "));
}

const nums = (t: string[]) => t.filter((x) => /\d/.test(x)).sort().join("|");

export function similarity(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function nearDuplicate(a: string, b: string, threshold = 0.8): boolean {
  if (fingerprint(a) === fingerprint(b)) return true;
  const ta = tokens(a), tb = tokens(b);
  if (nums(ta) !== nums(tb)) return false; // a different figure is a different fact
  return similarity(a, b) >= threshold;
}

export interface Known {
  market: string;
  text: string;
  from: string;
}

/** Every fact text we already hold: queued (non-rejected) items + submission notes (local or listSubmissions). */
export function knownFacts(state: State, opts: { excludeItem?: string } = {}): Known[] {
  const out: Known[] = [];
  for (const i of state.items) if (i.status !== "rejected" && i.id !== opts.excludeItem) out.push({ market: i.market, text: i.fact.text, from: `item ${i.id}` });
  for (const s of state.submissions) if (s.note) out.push({ market: s.market, text: s.note, from: `submission ${s.id}` });
  return out;
}

export interface NoveltyResult {
  novel: boolean;
  duplicateOf?: string;
  crossMarket?: string;
}

/** Candidate fact texts inside a stored text: the whole text, and each line with any "As of <date>:" prefix removed. */
function candidates(text: string): string[] {
  const lines = text.split(/\n+/).map((l) => l.replace(/^\s*as of [^:]{4,40}:\s*/i, "").trim()).filter(Boolean);
  return [text, ...lines];
}

/** Notes are longer than the fact; compare against each note line and also check containment. */
export function checkNovelty(state: State, market: string, factText: string, opts: { excludeItem?: string } = {}): NoveltyResult {
  const ft = tokens(factText).join(" ");
  let cross: string | undefined;
  for (const k of knownFacts(state, opts)) {
    const kt = tokens(k.text).join(" ");
    const dup = candidates(k.text).some((c) => nearDuplicate(c, factText)) || (ft.length >= 15 && kt.includes(ft));
    if (!dup) continue;
    if (k.market.toLowerCase() === market.toLowerCase()) return { novel: false, duplicateOf: k.from };
    cross ??= k.from;
  }
  return { novel: true, crossMarket: cross };
}
