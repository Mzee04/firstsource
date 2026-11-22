// Part 2 + 3: which pages to watch for a market.
//  - official: the market's declared dataSources (URLs only; named sources without a URL are reported, never guessed)
//  - calendar: release calendars from config/sources.json whose `match` regex hits the question
//  - regional: local/regional sources from config/sources.json when the question names a place
import fs from "node:fs";
import type { MarketCard, SourceRef } from "./types.ts";
import { isUrl } from "./text.ts";

/** type: "rss" (feed), "page" (HTML page / newsroom), "calendar" (release or event schedule). Informational. */
export type SourceType = "rss" | "page" | "calendar";

export interface SourcesConfig {
  calendars: { match: string; url: string; label?: string; type?: SourceType; topic?: string }[];
  regional: { place: string; aliases?: string[]; urls: string[] }[];
  /** Extra official pages per topic (e.g. the agency's release page). Same matching as calendars. */
  official?: { match: string; url: string; label?: string; type?: SourceType; topic?: string }[];
  /** Extra hard-to-fetch hosts (evidence from them needs pasted key text + a dated screenshot). */
  hardToFetch?: string[];
}

export function loadSourcesConfig(file: string): SourcesConfig {
  if (!fs.existsSync(file)) return { calendars: [], regional: [], official: [], hardToFetch: [] };
  const c = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SourcesConfig>;
  return { calendars: c.calendars ?? [], regional: c.regional ?? [], official: c.official ?? [], hardToFetch: c.hardToFetch ?? [] };
}

// Small built-in gazetteer for place detection. Regional URLs still come only from config.
const GAZETTEER = [
  "United States", "USA", "U.S.", "UK", "United Kingdom", "Canada", "Mexico", "Brazil", "Argentina", "Germany", "France",
  "Italy", "Spain", "Netherlands", "Switzerland", "Sweden", "Norway", "Poland", "Ukraine", "Russia", "Turkey", "Israel",
  "Iran", "Saudi Arabia", "UAE", "Egypt", "South Africa", "Kenya", "Ethiopia", "Ghana", "India", "Pakistan", "China",
  "Japan", "South Korea", "Taiwan", "Hong Kong", "Singapore", "Indonesia", "Philippines", "Vietnam", "Thailand",
  "Australia", "New Zealand", "European Union", "EU", "Eurozone", "New York", "California", "Texas", "Florida",
  "London", "Paris", "Berlin", "Tokyo", "Seoul", "Beijing", "Shanghai", "Mumbai", "Delhi", "Sydney", "Toronto",
  "Chicago", "Los Angeles", "San Francisco", "Washington", "Dubai",
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (q: string, w: string) => new RegExp(`(^|[^A-Za-z])${esc(w)}($|[^A-Za-z])`).test(q);

export function detectPlaces(question: string, cfg: SourcesConfig): string[] {
  const names = new Set<string>();
  for (const r of cfg.regional) for (const n of [r.place, ...(r.aliases ?? [])]) if (hasWord(question, n)) names.add(r.place);
  for (const g of GAZETTEER) if (hasWord(question, g)) names.add(g);
  return [...names];
}

export interface SourcePlan {
  sources: SourceRef[];
  places: string[];
  unresolved: string[]; // dataSources entries that are not URLs (need a human to supply the URL)
}

export function planSources(m: MarketCard, cfg: SourcesConfig): SourcePlan {
  const out: SourceRef[] = [];
  const unresolved: string[] = [];
  for (const d of m.dataSources ?? []) (isUrl(d) ? out.push({ url: d.trim(), kind: "official", label: "declared dataSource" }) : unresolved.push(d));
  for (const o of cfg.official ?? []) if (new RegExp(o.match, "i").test(m.question)) out.push({ url: o.url, kind: "primary", label: o.label });
  for (const c of cfg.calendars) if (new RegExp(c.match, "i").test(m.question)) out.push({ url: c.url, kind: "calendar", label: c.label });
  const places = detectPlaces(m.question, cfg);
  for (const r of cfg.regional) if (places.includes(r.place)) for (const u of r.urls) out.push({ url: u, kind: "regional", label: r.place });
  const seen = new Set<string>();
  return { sources: out.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true))), places, unresolved };
}
