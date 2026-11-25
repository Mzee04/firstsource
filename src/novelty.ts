/** Novelty filter. A fact is "not new" if its fingerprint (normalized text, dates in ISO,
 * comma-stripped figures) or a near-duplicate already exists in our queue, our submissions,
 * or the notes returned by listSubmissions. Same-market duplicates block; a duplicate on
 * another market is reported as a warning.
 *
 * Near-duplicates require the same canonical figure set (so a new number is a new fact) and
 * then either high stemmed-token overlap or mid token overlap plus shingle overlap (paraphrases).
 */
import type { State } from "./types.ts";
import { extractFigures, normalizeDates, normalizeFigures, normalizeMonthYears, sha256, tokens } from "./text.ts";

/** Light inflectional stemmer. Numbers and short tokens are left alone. */
export function stemToken(t: string): string {
  if (/\d/.test(t) || t.length <= 4) return t;
  let w = t.toLowerCase();
  if (w.endsWith("ies") && w.length > 5) return w.slice(0, -3) + "y";
  if (/(sses|zzes|xes)$/.test(w) && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 6) {
    w = w.slice(0, -3);
    if (w.length >= 2 && w.at(-1) === w.at(-2)) w = w.slice(0, -1);
    return w;
  }
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 4) return w.slice(0, -1);
  return w;
}

export function contentTokens(text: string): string[] {
  return tokens(normalizeFigures(normalizeMonthYears(normalizeDates(text)))).map(stemToken);
}

/** Sorted canonical figures (and ISO dates) that identify "this update" vs a different one. */
export function figureKey(text: string): string {
  const t = normalizeFigures(normalizeMonthYears(normalizeDates(text)));
  const dates = [...t.matchAll(/\b\d{4}-\d{2}(?:-\d{2})?\b/g)].map((m) => m[0]);
  const years = new Set(dates.map((d) => d.slice(0, 4)));
  const rest = extractFigures(t).filter((f) => !years.has(f) && !dates.includes(f) && !dates.some((d) => d === f || d.startsWith(f + "-")));
  return [...new Set([...dates, ...rest])].sort().join("|");
}

export function fingerprint(text: string): string {
  return sha256(contentTokens(text).join(" "));
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function shingles(toks: string[], n = 3): Set<string> {
  const out = new Set<string>();
  if (toks.length < n) {
    if (toks.length) out.add(toks.join(" "));
    return out;
  }
  for (let i = 0; i <= toks.length - n; i++) out.add(toks.slice(i, i + n).join(" "));
  return out;
}

export function similarity(a: string, b: string): number {
  return jaccard(contentTokens(a), contentTokens(b));
}

/**
 * True when `a` and `b` are the same fact, possibly paraphrased.
 * A different figure or date set is always a different fact.
 */
export function nearDuplicate(a: string, b: string, threshold = 0.8): boolean {
  if (fingerprint(a) === fingerprint(b)) return true;
  if (figureKey(a) !== figureKey(b)) return false;
  const ta = contentTokens(a), tb = contentTokens(b);
  const tok = jaccard(ta, tb);
  if (tok >= threshold) return true;
  // Same figures, looser wording: mid token overlap, or mid overlap plus 2-gram shingles.
  const sh = jaccard(shingles(ta, 2), shingles(tb, 2));
  return tok >= 0.65 || (tok >= 0.55 && sh >= 0.35);
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
  const ft = contentTokens(factText).join(" ");
  let cross: string | undefined;
  for (const k of knownFacts(state, opts)) {
    const kt = contentTokens(k.text).join(" ");
    const dup = candidates(k.text).some((c) => nearDuplicate(c, factText)) || (ft.length >= 15 && kt.includes(ft));
    if (!dup) continue;
    if (k.market.toLowerCase() === market.toLowerCase()) return { novel: false, duplicateOf: k.from };
    cross ??= k.from;
  }
  return { novel: true, crossMarket: cross };
}
