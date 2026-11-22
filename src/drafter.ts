// Part 8: note drafter. Short, dated, sourced, and says which way it points.
import type { Fact, PreflightResult, Side } from "./types.ts";

export function draftNote(o: { question: string; fact: Fact; side: Side | null; preflight: PreflightResult; max?: number }): string {
  const max = o.max ?? 1200;
  const { fact } = o;
  const lines = [
    `As of ${fact.date}: ${fact.text}`,
    `Source: ${fact.publisher} (${fact.sourceKind === "official" ? "market's declared data source" : fact.sourceKind === "regional" ? "local/regional source" : fact.sourceKind}), ${fact.source}`,
  ];
  if (!o.preflight.readable) {
    lines.push(`Key text (quoted from the source, captured ${o.preflight.checkedAt.slice(0, 16).replace("T", " ")} UTC; a dated capture is attached because the page may not load without a browser): "${fact.text}"`);
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
