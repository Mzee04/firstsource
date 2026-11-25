// One scan pass = parts 1-8: pick markets, read their official/calendar/regional sources, extract
// dated facts, drop non-novel ones, call the side, preflight the link, draft the note, and queue
// the result as "pending" for human review.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import type { MarketCard, QueueItem, State } from "./types.ts";
import { pickMarkets, type Pick } from "./picker.ts";
import { loadSourcesConfig, planSources } from "./sources.ts";
import { plainFetch } from "./fetcher.ts";
import { extractFacts } from "./extract.ts";
import { checkNovelty, fingerprint } from "./novelty.ts";
import { inferSide } from "./side.ts";
import { sideCompatible } from "./rules.ts";
import { isBlockedHost, preflight } from "./preflight.ts";
import { buildEvidence, defaultCapturer, redraftItem, type Capturer } from "./capture.ts";
import { hardHostList } from "./hardsource.ts";
import { logEvent } from "./feedbacklog.ts";
import { domainWeight, isAvoidedSource } from "./learn.ts";
import { hostOf, sha256, uuidFromSeed } from "./text.ts";

export async function loadMarkets(cfg: Config, fetchImpl: typeof fetch = fetch): Promise<MarketCard[]> {
  let body: unknown;
  if (cfg.marketsFile) body = JSON.parse(fs.readFileSync(cfg.marketsFile, "utf8"));
  else {
    if (!cfg.siteUrl) throw new Error("set COMPETITION_SITE_URL (or FIRSTSOURCE_MARKETS_FILE)");
    const res = await fetchImpl(new URL("/markets.json", cfg.siteUrl).toString());
    if (!res.ok) throw new Error(`GET /markets.json failed: ${res.status}`);
    body = await res.json();
  }
  const list = Array.isArray(body) ? body : (body as { markets?: unknown[] }).markets;
  if (!Array.isArray(list)) throw new Error("markets.json: expected an array or { markets: [...] }");
  const out: MarketCard[] = [];
  for (const raw of list) {
    const m = normalizeMarket(raw);
    if (m) out.push(m);
  }
  return out;
}

/** Validate one markets.json entry; malformed entries are dropped, never half-used. */
export function normalizeMarket(raw: unknown): MarketCard | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.address !== "string" || !m.address.trim() || typeof m.question !== "string" || !m.question.trim()) return null;
  const odds = m.odds as { yes?: unknown; no?: unknown } | undefined;
  const yes = Number(odds?.yes);
  if (!odds || typeof odds !== "object" || !Number.isFinite(yes)) return null;
  const ds = Array.isArray(m.dataSources) ? m.dataSources.filter((d): d is string => typeof d === "string" && !!d.trim()) : typeof m.dataSources === "string" && m.dataSources.trim() ? [m.dataSources] : [];
  return { ...m, address: m.address.trim(), question: m.question.trim(), status: String(m.status ?? ""), odds: { yes, no: Number(odds.no) }, evidenceCutoffAt: String(m.evidenceCutoffAt ?? ""), dataSources: ds } as MarketCard;
}

export interface ScanReport {
  picks: Pick[];
  added: QueueItem[];
  skipped: { market: string; why: string }[];
  unresolvedSources: { market: string; sources: string[] }[];
  watchesAdded: number;
}

export async function scan(state: State, cfg: Config, opts: { fetch?: typeof fetch; now?: number; perMarket?: number; limit?: number; capture?: Capturer | null } = {}): Promise<ScanReport> {
  const now = opts.now ?? Date.now();
  const markets = await loadMarkets(cfg, opts.fetch);
  const picks = pickMarkets(markets, state, { now, limit: opts.limit ?? 8 });
  const scfg = loadSourcesConfig(cfg.sourcesFile);
  const hardHosts = hardHostList(scfg.hardToFetch, cfg.hardHosts);
  const capture = opts.capture === undefined ? defaultCapturer(cfg) : opts.capture;
  const rep: ScanReport = { picks, added: [], skipped: [], unresolvedSources: [], watchesAdded: 0 };
  for (const p of picks) {
    const m = p.market;
    const plan = planSources(m, scfg);
    if (plan.unresolved.length) rep.unresolvedSources.push({ market: m.address, sources: plan.unresolved });
    const pendingHere = state.items.filter((i) => i.market === m.address && i.status === "pending").length;
    let budget = Math.min(opts.perMarket ?? cfg.perMarket, p.slotsLeft) - pendingHere;
    if (budget <= 0) { rep.skipped.push({ market: m.address, why: "enough pending items already" }); continue; }
    const facts = [];
    for (const s of plan.sources) {
      if (isAvoidedSource(state, s.url, m.dataSources)) { rep.skipped.push({ market: m.address, why: `avoided domain ${hostOf(s.url)}` }); continue; }
      if (isBlockedHost(s.url)) {
        rep.skipped.push({ market: m.address, why: `source ${s.url} needs a browser/login: read it yourself, then queue it with add-manual (pasted key text + dated screenshot)` });
        logEvent(cfg.dataDir, { kind: "unreadable_source", detail: "login/JS-walled host: not readable by a plain fetch, skipped", url: s.url, market: m.address });
        continue;
      }
      const f = await plainFetch(s.url, { fetch: opts.fetch });
      if (!f.ok) {
        const why = f.error ?? `HTTP ${f.status}`;
        rep.skipped.push({ market: m.address, why: `source ${s.url}: ${why}` });
        logEvent(cfg.dataDir, { kind: "fetch_failure", detail: why, url: s.url, market: m.address });
        continue;
      }
      const ex = extractFacts(m, s, f, now);
      for (const w of ex.watches) {
        if (!state.watches.some((x) => x.market === w.market && x.date === w.date && x.source === w.source)) { state.watches.push(w); rep.watchesAdded++; }
      }
      facts.push(...ex.facts);
    }
    facts.sort((a, b) => b.relevance * domainWeight(state, b.source) - a.relevance * domainWeight(state, a.source) || b.date.localeCompare(a.date));
    for (const fact of facts) {
      if (budget <= 0) break;
      const nv = checkNovelty(state, m.address, fact.text);
      if (!nv.novel) { rep.skipped.push({ market: m.address, why: `not novel (${nv.duplicateOf}): ${fact.text.slice(0, 60)}` }); continue; }
      const sideCall = inferSide(m.question, fact.text);
      const sc = sideCompatible(state, m.address, sideCall.side);
      if (!sc.ok) { rep.skipped.push({ market: m.address, why: `${sc.reason}: ${fact.text.slice(0, 60)}` }); continue; }
      const fp = fingerprint(fact.text);
      const id = sha256(`${m.address.toLowerCase()}|${fp}`).slice(0, 10);
      // Seen before (e.g. rejected by the reviewer): skip before any fetch or capture write.
      if (state.items.some((i) => i.id === id)) continue;
      const pf = await preflight(fact.source, fact.text, { fetch: opts.fetch, now });
      const forced = state.lessons.forceFallbackDomains.includes(hostOf(fact.source));
      if (forced) pf.reasons.push("past verdicts say the judge could not read this domain");
      if (!pf.readable) logEvent(cfg.dataDir, { kind: "unreadable_source", detail: pf.reasons.join("; "), url: fact.source, market: m.address, itemId: id });
      const side = sideCall.side;
      const ev = await buildEvidence({ cfg, id, market: m.address, question: m.question, fact, side, pf, hardHosts, forced, capture, now });
      const item: QueueItem = {
        id,
        market: m.address,
        question: m.question,
        cutoffAt: m.evidenceCutoffAt || undefined,
        fact,
        side,
        sideCall,
        note: ev.note,
        links: [fact.source],
        files: ev.files,
        preflight: pf,
        mode: ev.mode,
        requiresScreenshot: ev.requiresScreenshot || undefined,
        screenshotReason: ev.screenshotReason,
        status: "pending",
        idempotencyKey: uuidFromSeed(id),
        fingerprint: fp,
        createdAt: new Date(now).toISOString(),
        dryRuns: [],
      };
      state.items.push(item);
      rep.added.push(item);
      budget--;
    }
  }
  return rep;
}

/** Recompute the note after a reviewer changes the side. */
export function redraft(item: QueueItem, maxLen = 1200): void {
  redraftItem(item, maxLen);
}
