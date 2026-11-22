// Part 8: note drafter. Short, dated, sourced, and says which way it points.
// For a source the judge cannot read (X, Reddit, paywall, login wall, JS-only page) the note always
// carries the key text quoted from the source and says a dated capture/screenshot is attached.
import type { Fact, PreflightResult, Side } from "./types.ts";

const KIND_LABEL: Record<string, string> = {
  official: "market's declared data source",
  primary: "official primary source",
  calendar: "official release calendar",
  regional: "local/regional source",
  manual: "source checked by a human",
};

export function draftNote(o: { question: string; fact: Fact; side: Side | null; preflight: PreflightResult; max?: number; screenshot?: boolean; keyText?: string }): string {
  const max = o.max ?? 1200;
  const { fact } = o;
  const quote = o.keyText?.trim() || fact.text;
  const lines = [
    `As of ${fact.date}: ${fact.text}`,
    `Source: ${fact.publisher} (${KIND_LABEL[fact.sourceKind] ?? fact.sourceKind}), ${fact.source}`,
  ];
  if (!o.preflight.readable || o.screenshot) {
    const att = o.screenshot ? "a dated screenshot showing the URL and capture date is attached" : "a dated capture is attached";
    lines.push(`Key text (quoted from the source, captured ${o.preflight.checkedAt.slice(0, 16).replace("T", " ")} UTC; ${att} because the page may not load with a basic fetch): "${quote}"`);
  }
  if (o.side) lines.push(`Relevance: this dated fact bears on "${o.question}" and points toward ${o.side}.`);
  let note = lines.join("\n");
  if (note.length > max) {
    const over = note.length - max + 1;
    const cut = Math.max(40, fact.text.length - over);
    note = note.replaceAll(fact.text, fact.text.slice(0, cut).trimEnd() + "…");
    if (note.length > max) note = note.slice(0, max - 1) + "…";
  }
  return note;
}
