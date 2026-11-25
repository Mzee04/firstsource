// Part 4: extract dated facts from a fetched page. A fact is a sentence that (a) mentions the
// market's subject, (b) carries a number or a concrete outcome, and (c) has a date — in the
// sentence itself, else the page's published date. Future dates become calendar watches instead.
import type { Fact, MarketCard, SourceRef, Watch } from "./types.ts";
import type { Fetched } from "./fetcher.ts";
import { decodeEntities, findDates, hostOf, htmlToText, keywords, sentences, todayUtc, tokens } from "./text.ts";

/** Publication date from page metadata or byline text. Not HTTP Last-Modified. */
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
  // HTTP Last-Modified is a cache/file timestamp, not the fact's publication date — never use it here.
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

// RSS / Atom feeds: each item becomes its own mini-page, cited by the ITEM link (the article the
// judge will fetch), dated by the item's pubDate/updated, so a feed never becomes the cited source.
export interface FeedItem { title: string; link: string | null; date: string | null; text: string }

const unCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c);
const tag = (block: string, names: string[]): string | null => {
  for (const n of names) {
    const m = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, "i").exec(block);
    if (m) return unCdata(m[1]).trim();
  }
  return null;
};

export function isFeed(f: Pick<Fetched, "contentType" | "body">): boolean {
  return /(rss|atom)\+xml/i.test(f.contentType) || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(f.body.slice(0, 2000));
}

export function parseFeed(body: string, max = 60): { title: string | null; items: FeedItem[] } {
  const title = tag(body.replace(/<(item|entry)\b[\s\S]*$/i, ""), ["title"]);
  const items: FeedItem[] = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) && items.length < max) {
    const b = m[2];
    const t = htmlToText(decodeEntities(tag(b, ["title"]) ?? ""));
    const linkTag = tag(b, ["link"]);
    const href = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(b)?.[1] ?? /<link\b[^>]*href=["']([^"']+)["']/i.exec(b)?.[1];
    const link = (linkTag && /^https?:\/\//i.test(decodeEntities(linkTag)) ? decodeEntities(linkTag) : href ? decodeEntities(href) : tag(b, ["guid"]))?.trim() ?? null;
    const rawDate = tag(b, ["pubDate", "published", "updated", "dc:date"]);
    const date = rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString().slice(0, 10) : rawDate ? findDates(rawDate)[0] ?? null : null;
    const desc = tag(b, ["description", "summary", "content:encoded", "content"]) ?? "";
    const text = htmlToText(decodeEntities(desc)).slice(0, 4000);
    items.push({ title: t, link: link && /^https?:\/\//i.test(link) ? link : null, date, text });
  }
  return { title: title ? htmlToText(decodeEntities(title)) : null, items };
}

export function extractFacts(m: MarketCard, src: SourceRef, f: Fetched, now = Date.now()): Extraction {
  const facts: Fact[] = [];
  const watches: Watch[] = [];
  if (!f.ok || !f.body) return { facts, watches };
  const kw = keywords(m.question);
  const today = todayUtc(now);
  const ct = Date.parse(m.evidenceCutoffAt);
  const cutoff = Number.isFinite(ct) ? new Date(ct).toISOString().slice(0, 10) : "9999-12-31";
  const fetchedAt = new Date(now).toISOString();
  const pages: { text: string; pd: string | null; source: string; publisher: string }[] = [];
  if (isFeed(f)) {
    const feed = parseFeed(f.body);
    for (const it of feed.items) pages.push({ text: `${it.title}${/[.!?]$/.test(it.title) ? "" : "."}\n${it.text}`, pd: it.date, source: it.link ?? (f.finalUrl || f.url), publisher: feed.title || hostOf(f.finalUrl || f.url) });
  } else {
    const text = /html/i.test(f.contentType) || /<html|<body|<p[ >]/i.test(f.body) ? htmlToText(f.body) : f.body;
    pages.push({ text, pd: pageDate(f), source: f.finalUrl || f.url, publisher: publisherOf(f) });
  }
  for (const pg of pages) for (const s of sentences(pg.text)) {
    const pd = pg.pd;
    const st = new Set(tokens(s));
    const hits = kw.filter((k) => st.has(k)).length;
    const relevance = kw.length ? hits / kw.length : 0;
    if (hits < 2 && relevance < 0.3) continue;
    const dates = findDates(s);
    const future = dates.filter((d) => d > today);
    const past = dates.filter((d) => d <= today);
    if (src.kind === "calendar" || (future.length && !past.length)) {
      for (const d of future) if (d <= cutoff || src.kind === "calendar") watches.push({ market: m.address, source: pg.source, date: d, text: s, addedAt: fetchedAt });
      continue; // a scheduled/future item is a watch, not a fact
    }
    if (!NUMBER.test(s.replace(/\d{4}-\d{2}-\d{2}/g, "")) && !OUTCOME.test(s)) continue;
    const date = past.sort().at(-1) ?? (pd && pd <= today ? pd : null);
    if (!date) continue; // undated -> not a fact
    if (date > cutoff) continue;
    facts.push({ market: m.address, date, text: s, source: pg.source, sourceKind: src.kind, publisher: pg.publisher, fetchedAt, relevance });
  }
  facts.sort((a, b) => b.relevance - a.relevance || b.date.localeCompare(a.date));
  return { facts, watches };
}
