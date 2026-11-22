// Part 4: extract dated facts from a fetched page. A fact is a sentence that (a) mentions the
// market's subject, (b) carries a number or a concrete outcome, and (c) has a date — in the
// sentence itself, else the page's published date. Future dates become calendar watches instead.
import type { Fact, MarketCard, SourceRef, Watch } from "./types.ts";
import type { Fetched } from "./fetcher.ts";
import { findDates, hostOf, htmlToText, keywords, sentences, todayUtc, tokens } from "./text.ts";

export function pageDate(f: Fetched): string | null {
  const b = f.body;
  const meta =
    /<meta[^>]+(?:property|name)=["'](?:article:published_time|date|dc\.date|publish-date|pubdate)["'][^>]*content=["']([^"']+)["']/i.exec(b)?.[1] ??
    /<time[^>]+datetime=["']([^"']+)["']/i.exec(b)?.[1];
  if (meta) {
    const d = findDates(meta)[0] ?? (Number.isFinite(Date.parse(meta)) ? new Date(meta).toISOString().slice(0, 10) : null);
    if (d) return d;
  }
  const txt = htmlToText(b).slice(0, 3000);
  const m = /(published|released|updated|issued)[^\n]{0,20}?:?\s*([^\n]{6,40})/i.exec(txt);
  if (m) {
    const d = findDates(m[2])[0];
    if (d) return d;
  }
  if (f.lastModified && Number.isFinite(Date.parse(f.lastModified))) return new Date(f.lastModified).toISOString().slice(0, 10);
  return null;
}

export function publisherOf(f: Fetched): string {
  const t = /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i.exec(f.body)?.[1];
  return t?.trim() || hostOf(f.finalUrl || f.url);
}

const OUTCOME = /\b(approved|rejected|passed|failed|signed|vetoed|announced|confirmed|launched|cancel(?:l)?ed|postponed|delayed|cut|raised|held|unchanged|won|lost|elected|resigned|scheduled|completed|denied|ruled)\b/i;
const NUMBER = /(^|[\s(])[$€£]?\d/; // a standalone figure, not "Vega-2"

export interface Extraction {
  facts: Fact[];
  watches: Watch[];
}

export function extractFacts(m: MarketCard, src: SourceRef, f: Fetched, now = Date.now()): Extraction {
  const facts: Fact[] = [];
  const watches: Watch[] = [];
  if (!f.ok || !f.body) return { facts, watches };
  const text = /html/i.test(f.contentType) || /<html|<body|<p[ >]/i.test(f.body) ? htmlToText(f.body) : f.body;
  const kw = keywords(m.question);
  const pd = pageDate(f);
  const today = todayUtc(now);
  const ct = Date.parse(m.evidenceCutoffAt);
  const cutoff = Number.isFinite(ct) ? new Date(ct).toISOString().slice(0, 10) : "9999-12-31";
  const publisher = publisherOf(f);
  const fetchedAt = new Date(now).toISOString();
  for (const s of sentences(text)) {
    const st = new Set(tokens(s));
    const hits = kw.filter((k) => st.has(k)).length;
    const relevance = kw.length ? hits / kw.length : 0;
    if (hits < 2 && relevance < 0.3) continue;
    const dates = findDates(s);
    const future = dates.filter((d) => d > today);
    const past = dates.filter((d) => d <= today);
    if (src.kind === "calendar" || (future.length && !past.length)) {
      for (const d of future) if (d <= cutoff || src.kind === "calendar") watches.push({ market: m.address, source: f.finalUrl, date: d, text: s, addedAt: fetchedAt });
      continue; // a scheduled/future item is a watch, not a fact
    }
    if (!NUMBER.test(s.replace(/\d{4}-\d{2}-\d{2}/g, "")) && !OUTCOME.test(s)) continue;
    const date = past.sort().at(-1) ?? (pd && pd <= today ? pd : null);
    if (!date) continue; // undated -> not a fact
    if (date > cutoff) continue;
    facts.push({ market: m.address, date, text: s, source: f.finalUrl || f.url, sourceKind: src.kind, publisher, fetchedAt, relevance });
  }
  facts.sort((a, b) => b.relevance - a.relevance || b.date.localeCompare(a.date));
  return { facts, watches };
}
