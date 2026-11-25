/** Note drafter: short, dated, sourced, and says which way it points.
 * For a source the judge cannot read (X, Reddit, paywall, login wall, JS-only page) the note always
 * carries the key text quoted from the source and says a dated capture/screenshot is attached.
 */
import type { Fact, PreflightResult, Side } from "./types.ts";

const KIND_LABEL: Record<string, string> = {
  official: "market's declared data source",
  primary: "official primary source",
  calendar: "official release calendar",
  regional: "local/regional source",
  manual: "source checked by a human",
};

/**
 * Keep a side line that always ends with "points toward YES|NO", shrinking the question if needed
 * so the line fits in `max` characters.
 */
export function sideLineFor(question: string, side: Side, max: number): string {
  const end = `points toward ${side}.`;
  let line = `Relevance: this dated fact bears on "${question}" and ${end}`;
  if (line.length <= max) return line;
  const room = max - end.length - 36; // 'Relevance: this dated fact bears on "' + '" and '
  const q = room >= 8 ? question.slice(0, room).trimEnd() + "…" : "…";
  line = `Relevance: this dated fact bears on "${q}" and ${end}`;
  return line.length <= max ? line : end.slice(0, max);
}

/**
 * Draft the evidence note. Truncation shortens the fact/quote/source body first and
 * never drops the "points toward YES|NO" side line when a side is set.
 */
export function draftNote(o: { question: string; fact: Fact; side: Side | null; preflight: PreflightResult; max?: number; screenshot?: boolean; keyText?: string }): string {
  const max = o.max ?? 1200;
  const { fact } = o;
  const quote = o.keyText?.trim() || fact.text;
  const side = o.side ? sideLineFor(o.question, o.side, max) : "";
  const budget = Math.max(0, max - (side ? side.length + 1 : 0));

  const keyLine = (!o.preflight.readable || o.screenshot)
    ? `Key text (quoted from the source, captured ${o.preflight.checkedAt.slice(0, 16).replace("T", " ")} UTC; ${o.screenshot ? "a dated screenshot showing the URL and capture date is attached" : "a dated capture is attached"} because the page may not load with a basic fetch): "${quote}"`
    : "";

  const build = (factText: string, key: string) => {
    const lines = [
      `As of ${fact.date}: ${factText}`,
      `Source: ${fact.publisher} (${KIND_LABEL[fact.sourceKind] ?? fact.sourceKind}), ${fact.source}`,
    ];
    if (key) lines.push(key);
    return lines.join("\n");
  };

  let factText = fact.text;
  let key = keyLine;
  let body = build(factText, key);
  if (body.length > budget) {
    const over = body.length - budget + 1;
    factText = factText.slice(0, Math.max(20, factText.length - over)).trimEnd() + "…";
    if (key.includes(fact.text)) key = key.replaceAll(fact.text, factText);
    body = build(factText, key);
  }
  if (body.length > budget && key) {
    const other = build(factText, "").length + 1;
    const room = budget - other;
    if (room >= 20) {
      key = key.slice(0, room - 1).trimEnd() + "…";
      body = build(factText, key);
    } else {
      body = build(factText, "");
    }
  }
  if (body.length > budget) body = budget >= 1 ? body.slice(0, budget - 1).trimEnd() + "…" : "";
  if (body.length > budget) body = body.slice(0, budget);
  return side ? (body ? `${body}\n${side}` : side) : body;
}
