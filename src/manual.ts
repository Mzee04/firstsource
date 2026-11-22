// `add-manual`: queue evidence from a source FirstSource cannot read itself (an X post, a Reddit
// thread, a paywalled article). The human reads the page and pastes the key text; FirstSource
// quotes it in the note and attaches a dated screenshot (captured with headless Chrome when
// available, else the human's --screenshot file). Without a screenshot the item is NOT queued.
import type { Config } from "./config.ts";
import type { Fact, MarketCard, QueueItem, Side, State } from "./types.ts";
import { checkNovelty, fingerprint } from "./novelty.ts";
import { inferSide } from "./side.ts";
import { isBlockedHost, preflight } from "./preflight.ts";
import { buildEvidence, checkScreenshotFile, defaultCapturer, type Capturer } from "./capture.ts";
import { hardHostList, hasImage } from "./hardsource.ts";
import { loadSourcesConfig } from "./sources.ts";
import { capCheck, cutoffCheck, lockedSide } from "./rules.ts";
import { hostOf, isUrl, sha256, uuidFromSeed } from "./text.ts";
import { logEvent } from "./feedbacklog.ts";

export interface ManualInput {
  market: MarketCard | { address: string; question: string; evidenceCutoffAt?: string };
  url: string;
  date: string; // YYYY-MM-DD
  text: string; // key text quoted from the source
  side?: Side;
  screenshot?: string;
  publisher?: string;
}

export async function addManual(state: State, cfg: Config, inp: ManualInput, opts: { fetch?: typeof fetch; now?: number; capture?: Capturer | null } = {}): Promise<QueueItem> {
  const now = opts.now ?? Date.now();
  const m = inp.market;
  if (!isUrl(inp.url)) throw new Error(`not an http(s) URL: ${inp.url}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inp.date) || !Number.isFinite(Date.parse(`${inp.date}T00:00:00Z`))) throw new Error("--date must be YYYY-MM-DD");
  const text = inp.text.replace(/\s+/g, " ").trim();
  if (text.length < 10) throw new Error("--text must be the key text quoted from the source (at least 10 characters)");
  if (inp.screenshot) checkScreenshotFile(inp.screenshot);
  const co = cutoffCheck({ cutoffAt: m.evidenceCutoffAt || undefined }, now);
  if (!co.ok) throw new Error(`refusing to queue: ${co.reason}`);
  const cc = capCheck(state, m.address);
  if (!cc.ok) throw new Error(`refusing to queue: ${cc.reason}`);
  const nv = checkNovelty(state, m.address, text);
  if (!nv.novel) throw new Error(`refusing to queue: duplicate of ${nv.duplicateOf}`);
  const sideCall = inp.side ? { side: inp.side, confidence: "high" as const, reason: "set by reviewer (add-manual)" } : inferSide(m.question, text);
  const locked = lockedSide(state, m.address);
  if (locked && sideCall.side && sideCall.side !== locked) throw new Error(`refusing to queue: argues ${sideCall.side}, market locked to ${locked}`);
  const fp = fingerprint(text);
  const id = sha256(`${m.address.toLowerCase()}|${fp}`).slice(0, 10);
  if (state.items.some((i) => i.id === id)) throw new Error(`already queued as ${id}`);

  const pf = await preflight(inp.url, text, { fetch: opts.fetch, now });
  if (!pf.readable) logEvent(cfg.dataDir, { kind: "unreadable_source", detail: pf.reasons.join("; "), url: inp.url, market: m.address, itemId: id });
  const scfg = loadSourcesConfig(cfg.sourcesFile);
  const hardHosts = hardHostList(scfg.hardToFetch, cfg.hardHosts);
  const fact: Fact = { market: m.address, date: inp.date, text, source: inp.url, sourceKind: "manual", publisher: inp.publisher?.trim() || hostOf(inp.url), fetchedAt: new Date(now).toISOString(), relevance: 1 };
  const capture = opts.capture === undefined ? defaultCapturer(cfg) : opts.capture;
  const ev = await buildEvidence({ cfg, id, market: m.address, question: m.question, fact, side: sideCall.side, pf, hardHosts, forced: isBlockedHost(inp.url), keyText: text, userScreenshot: inp.screenshot, capture, now });
  if (ev.requiresScreenshot && !hasImage(ev.files)) {
    throw new Error(`refusing to queue: ${ev.screenshotReason}, so the judge needs a dated screenshot showing the URL and date${ev.screenshotError ? ` (automatic capture failed: ${ev.screenshotError})` : " (no headless browser available)"}. Take one yourself and re-run with --screenshot shot.png`);
  }
  const item: QueueItem = {
    id, market: m.address, question: m.question, cutoffAt: m.evidenceCutoffAt || undefined, fact, side: sideCall.side, sideCall,
    note: ev.note, links: [inp.url], files: ev.files, preflight: pf, mode: ev.mode, status: "pending",
    idempotencyKey: uuidFromSeed(id), fingerprint: fp, createdAt: new Date(now).toISOString(), dryRuns: [],
    requiresScreenshot: ev.requiresScreenshot || undefined, screenshotReason: ev.screenshotReason,
  };
  state.items.push(item);
  return item;
}
