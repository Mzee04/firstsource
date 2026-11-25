// Tests for the 22 Nov improvements: hard-to-fetch sources + dated screenshots, same-key retries
// after timeouts, the feedback-bounty log/draft, curated sources and RSS/Atom feeds, agent headers.
// Local mock only; no real network, no real API, no browser (unless FIRSTSOURCE_TEST_SCREENSHOT=1).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { startMock, MOCK_KEY, type Mock } from "../mock/server.ts";
import { describeConfig, loadConfig } from "../src/config.ts";
import { loadState, saveState } from "../src/store.ts";
import { scan } from "../src/scan.ts";
import { approve, attach, detach, setSide } from "../src/queue.ts";
import { ensureIdempotencyKey, submitItem, sync } from "../src/submit.ts";
import { makeClient } from "../src/api.ts";
import { addManual } from "../src/manual.ts";
import { DEFAULT_HARD_HOSTS, hardHostList, isHardHost, screenshotReason } from "../src/hardsource.ts";
import { draftFeedbackMarkdown, feedbackLogPath, logEvent, logVerdicts, readLog, redact } from "../src/feedbacklog.ts";
import { loadSourcesConfig, planSources } from "../src/sources.ts";
import { extractFacts, isFeed, parseFeed } from "../src/extract.ts";
import { preflight } from "../src/preflight.ts";
import { captureScreenshot, findChrome } from "../src/screenshot.ts";
import { uuidFromSeed } from "../src/text.ts";
import type { MarketCard, QueueItem, State } from "../src/types.ts";
import type { Capturer } from "../src/capture.ts";
import { item, state as emptyState } from "./helpers.ts";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let mock: Mock;
let srcFile: string;
const envFor = (dir: string, extra: Record<string, string> = {}) => ({ COMPETITION_SITE_URL: mock.url, DELPHI_API_URL: mock.apiUrl, DELPHI_API_ACCESS_KEY: MOCK_KEY, FIRSTSOURCE_DATA_DIR: dir, FIRSTSOURCE_SOURCES: srcFile, FIRSTSOURCE_SCREENSHOT: "off", ...extra });

before(async () => {
  mock = await startMock(0);
  srcFile = path.join(tmp("fs-imp-src-"), "sources.json");
  fs.writeFileSync(srcFile, JSON.stringify({ calendars: [{ match: "CPI|inflation", url: `${mock.url}/src/stats/calendar` }], regional: [{ place: "Northport", urls: [`${mock.url}/src/northport/news`] }], hardToFetch: ["example-paywall.test"] }));
  await new EvidenceClient({ baseUrl: mock.apiUrl, apiKey: MOCK_KEY }).acceptTerms(mock.terms.version); // mock only: owner accepted out of band
});
after(async () => { await mock.close(); });

const MARKET = (suffix: string) => `0xA${suffix[0]}000000000000000000000000000000000000c${suffix[0]}`;
const pngFile = (dir: string, name = "shot.png") => { const f = path.join(dir, name); fs.writeFileSync(f, PNG_1PX); return f; };

// ---------- 1. hard-to-fetch sources ----------

test("hard hosts: X, Reddit and paywalls by default; extra hosts from config and env", () => {
  for (const u of ["https://x.com/a/status/1", "https://twitter.com/a", "https://old.reddit.com/r/x", "https://www.ft.com/content/1", "https://www.wsj.com/a"]) assert.ok(isHardHost(u), u);
  assert.ok(!isHardHost("https://www.bls.gov/news.release/cpi.htm"));
  const hosts = hardHostList(["example-paywall.test"], ["News.Example.org"]);
  assert.ok(isHardHost("https://sub.example-paywall.test/a", hosts));
  assert.ok(isHardHost("https://news.example.org/a", hosts));
  assert.ok(DEFAULT_HARD_HOSTS.includes("reddit.com"));
  const cfg = loadConfig({ FIRSTSOURCE_HARD_HOSTS: "a.test, b.test" });
  assert.deepEqual(cfg.hardHosts, ["a.test", "b.test"]);
  const pf = { url: "https://news.test/a", checkedAt: "2026-11-22T00:00:00Z", readable: false, textLength: 900, keyTextFound: null, reasons: ["paywall / sign-in wall text found"] };
  assert.match(screenshotReason("https://news.test/a", pf)!, /paywall/);
  assert.equal(screenshotReason("https://news.test/a", { ...pf, reasons: ["HTTP 404"] }), null, "a 404 is not a hard host: advisory only");
});

const card = (suffix: string): MarketCard => ({ address: MARKET(suffix), question: "Will Orion Aerospace launch its Vega-2 rocket before 2026-12-31?", status: "open", odds: { yes: 0.5, no: 0.5 }, evidenceCutoffAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), dataSources: [] });
const X_URL = "https://x.com/orion_example/status/1";
const X_TEXT = "Orion Aerospace: Vega-2 completed its final static fire on November 17, 2026; launch is set for December 19, 2026.";

test("add-manual: an X post without a screenshot is refused (no browser available)", async () => {
  const cfg = loadConfig(envFor(tmp("fs-man1-")));
  const s = loadState(cfg.dataDir);
  const calls: string[] = [];
  const f: typeof fetch = (u, i) => { calls.push(String(u)); return fetch(u, i); };
  await assert.rejects(addManual(s, cfg, { market: card("4"), url: X_URL, date: "2026-11-17", text: X_TEXT, side: "YES" }, { capture: null, fetch: f }), /refusing to queue: x\.com is a hard-to-fetch host.*--screenshot/);
  assert.equal(s.items.length, 0, "not queued");
  assert.equal(calls.length, 0, "X is never fetched");
});

test("add-manual: with a user screenshot it is queued with quoted key text and one PNG (3 items: note + link + file)", async () => {
  const dir = tmp("fs-man2-");
  const cfg = loadConfig(envFor(dir));
  const s = loadState(cfg.dataDir);
  const it = await addManual(s, cfg, { market: card("4"), url: X_URL, date: "2026-11-17", text: X_TEXT, side: "YES", screenshot: pngFile(dir) }, { capture: null });
  assert.equal(it.requiresScreenshot, true);
  assert.equal(it.mode, "fallback");
  assert.ok(it.note.includes(`"${X_TEXT}"`), "key text quoted in the note");
  assert.match(it.note, /dated screenshot showing the URL and capture date is attached/);
  assert.equal(it.files.length, 1, "screenshot only: a text-PDF would push the bundle over the 3-item cap");
  assert.ok(it.files[0].endsWith(".png"));
  assert.equal(it.idempotencyKey, uuidFromSeed(it.id), "deterministic key stored at queue time");
  // official cap is 3 items (note + link + screenshot); a fourth item is refused
  assert.throws(() => attach(s, it.id, pngFile(dir, "extra.png")), /max 3 items/);
  detach(s, it.id, "shot.png");
  assert.throws(() => approve(s, it.id), /needs a dated screenshot/);
  attach(s, it.id, pngFile(dir, "again.png"));
  approve(s, it.id);
  const o = await submitItem(s, cfg, it.id);
  const req = JSON.parse(fs.readFileSync(o.dryRunFile!, "utf8"));
  assert.equal(req.params.files.length, 1);
  assert.ok(req.params.files.some((f: { type: string }) => f.type === "image/png"));
});

test("add-manual: an automatic capturer supplies the dated screenshot; a failed capture refuses and is logged", async () => {
  const dir = tmp("fs-man3-");
  const cfg = loadConfig(envFor(dir));
  const s = loadState(cfg.dataDir);
  const seen: string[] = [];
  const ok: Capturer = async (url, out, now) => { seen.push(url); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, PNG_1PX); return { ok: true, file: out, capturedAt: new Date(now).toISOString() }; };
  const it = await addManual(s, cfg, { market: card("4"), url: X_URL, date: "2026-11-17", text: X_TEXT, side: "YES" }, { capture: ok });
  assert.deepEqual(seen, [X_URL]);
  assert.ok(it.files.some((f) => /-screenshot-\d{4}-\d{2}-\d{2}\.png$/.test(f)));
  const bad: Capturer = async (_u, _o, now) => ({ ok: false, capturedAt: new Date(now).toISOString(), error: "navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE" });
  await assert.rejects(addManual(s, cfg, { market: card("4"), url: "https://www.reddit.com/r/space/comments/abc", date: "2026-11-18", text: "Orion Aerospace moved the Vega-2 launch window to December 20, 2026 per its launch director.", side: "YES" }, { capture: bad }), /automatic capture failed/);
  assert.ok(readLog(dir).some((e) => e.kind === "screenshot_failure" && e.url?.includes("reddit.com")));
});

test("scan: a paywalled source is flagged, captured automatically when a capturer exists, and blocked until it has a screenshot", async () => {
  const dir = tmp("fs-scanshot-");
  const cfg = loadConfig(envFor(dir));
  const s = loadState(cfg.dataDir);
  const cap: Capturer = async (_url, out, now) => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, PNG_1PX); return { ok: true, file: out, capturedAt: new Date(now).toISOString() }; };
  await scan(s, cfg, { capture: cap });
  const orion = s.items.find((i) => i.fact.text.includes("Vega-2"))!;
  assert.equal(orion.requiresScreenshot, true);
  assert.equal(orion.files.length, 1, "auto screenshot only; a PDF would exceed the 3-item cap");
  assert.ok(orion.files[0].endsWith(".png"));
  const s2 = loadState(tmp("fs-scanshot2-"));
  await scan(s2, loadConfig(envFor(tmp("fs-scanshot3-"))), { capture: null });
  const o2 = s2.items.find((i) => i.fact.text.includes("Vega-2"))!;
  assert.equal(o2.files.length, 0, "no screenshot available: leave the file slot free");
  assert.throws(() => approve(s2, o2.id), /needs a dated screenshot/);
});

test("screenshot: real headless capture shows URL + date (opt-in: FIRSTSOURCE_TEST_SCREENSHOT=1)", { skip: process.env.FIRSTSOURCE_TEST_SCREENSHOT !== "1" || !findChrome() }, async () => {
  const out = path.join(tmp("fs-shot-"), "s.png");
  const r = await captureScreenshot(`${mock.url}/src/cb/statement`, out, { timeoutMs: 60_000 });
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.statSync(out).size > 1000);
});

// ---------- 2. idempotency: same key on every retry ----------

async function approvedOn(dir: string, suffix: string): Promise<{ s: State; it: QueueItem; cfg: ReturnType<typeof loadConfig> }> {
  const cfg = loadConfig(envFor(dir, { FIRSTSOURCE_LIVE: "1" }));
  const s = loadState(cfg.dataDir);
  await scan(s, cfg, { capture: null });
  const it = s.items.find((i) => i.market === MARKET(suffix))!;
  assert.ok(it, `candidate on market c${suffix}`);
  if (!it.side) setSide(s, it.id, "YES");
  if (it.requiresScreenshot) attach(s, it.id, pngFile(dir));
  approve(s, it.id);
  return { s, it, cfg };
}

test("retry: connection dropped AFTER the server saved it -> found via GET /submissions, not re-sent", async () => {
  const { s, it, cfg } = await approvedOn(tmp("fs-idem1-"), "1");
  const before = mock.stats.submitCalls, subsBefore = mock.subs.length, k0 = mock.stats.idempotencyKeys.length;
  mock.faults.dropAfterLanding = 1;
  const o = await submitItem(s, cfg, it.id, { live: true, client: makeClient(cfg), wait: false, retryDelayMs: 0 });
  assert.equal(mock.stats.submitCalls - before, 1, "exactly one POST");
  assert.equal(mock.subs.length - subsBefore, 1, "exactly one submission on the server");
  assert.equal(o.alreadyLanded, true);
  assert.equal(it.status, "submitted");
  assert.equal(o.submissionId, mock.subs.at(-1)!.id);
  assert.deepEqual(mock.stats.idempotencyKeys.slice(k0), [it.idempotencyKey]);
  assert.ok(it.attempts!.every((a) => a.idempotencyKey === it.idempotencyKey));
  assert.ok(readLog(cfg.dataDir).some((e) => e.kind === "network_error"), "failure logged for the feedback draft");
});

test("retry: client TIMEOUT after landing -> found via GET /submissions, not re-sent", async () => {
  const { s, it, cfg } = await approvedOn(tmp("fs-idem2-"), "2");
  const before = mock.stats.submitCalls, subsBefore = mock.subs.length;
  mock.faults.hangAfterLanding = 1;
  mock.faults.hangMs = 1500;
  const o = await submitItem(s, cfg, it.id, { live: true, client: makeClient(cfg, undefined, 400), wait: false, retryDelayMs: 0 });
  assert.equal(mock.stats.submitCalls - before, 1);
  assert.equal(mock.subs.length - subsBefore, 1);
  assert.equal(o.alreadyLanded, true);
  assert.equal(it.submissionId, mock.subs.at(-1)!.id);
});

test("retry: dropped BEFORE landing -> resent with the SAME Idempotency-Key; one submission", async () => {
  const { s, it, cfg } = await approvedOn(tmp("fs-idem3-"), "3");
  const before = mock.stats.submitCalls, subsBefore = mock.subs.length, k0 = mock.stats.idempotencyKeys.length;
  mock.faults.dropBeforeLanding = 1;
  const o = await submitItem(s, cfg, it.id, { live: true, client: makeClient(cfg), wait: false, retryDelayMs: 0 });
  assert.equal(mock.stats.submitCalls - before, 2);
  assert.equal(mock.subs.length - subsBefore, 1);
  assert.equal(o.attempts, 2);
  assert.ok(!o.alreadyLanded);
  const keys = mock.stats.idempotencyKeys.slice(k0);
  assert.deepEqual(keys, [it.idempotencyKey, it.idempotencyKey], "never a new key");
});

test("retry: landed but GET /submissions lags -> resend with the same key returns the SAME submission", async () => {
  const { s, it, cfg } = await approvedOn(tmp("fs-idem4-"), "5");
  const before = mock.stats.submitCalls, subsBefore = mock.subs.length;
  mock.faults.dropAfterLanding = 1;
  mock.faults.listLag = 2; // the pre-send check and the post-failure check both miss it
  const o = await submitItem(s, cfg, it.id, { live: true, client: makeClient(cfg), wait: false, retryDelayMs: 0 });
  assert.equal(mock.stats.submitCalls - before, 2, "resent once");
  assert.equal(mock.subs.length - subsBefore, 1, "the server deduplicated by Idempotency-Key");
  assert.equal(o.submissionId, mock.subs.at(-1)!.id);
});

test("retry: gives up after maxAttempts keeping the item approved and the key unchanged; a later run reuses it", async () => {
  const dir = tmp("fs-idem5-");
  const { s, it, cfg } = await approvedOn(dir, "4");
  const key = it.idempotencyKey;
  mock.faults.dropBeforeLanding = 5;
  await assert.rejects(submitItem(s, cfg, it.id, { live: true, client: makeClient(cfg), wait: false, retryDelayMs: 0, maxAttempts: 2 }), /gave up after 2 attempt/);
  assert.equal(it.status, "approved");
  assert.equal(it.idempotencyKey, key);
  saveState(cfg.dataDir, s);
  mock.faults.dropBeforeLanding = 0;
  const s2 = loadState(cfg.dataDir); // a fresh run from the saved state
  const k0 = mock.stats.idempotencyKeys.length;
  const o = await submitItem(s2, cfg, it.id, { live: true, client: makeClient(cfg), wait: false, retryDelayMs: 0 });
  assert.equal(o.status !== undefined, true);
  assert.deepEqual(mock.stats.idempotencyKeys.slice(k0), [key]);
});

test("idempotency key: derived from the item id, filled in for old items, never replaced", () => {
  const a = item("0xm", "fact one 1.0%", "YES");
  const k = a.idempotencyKey;
  assert.equal(ensureIdempotencyKey(a), k);
  const b = { ...item("0xm", "fact two 2.0%", "YES"), idempotencyKey: "" };
  assert.equal(ensureIdempotencyKey(b), uuidFromSeed(b.id));
});

// ---------- 3. feedback log + draft ----------

test("feedback: failures and verdicts are logged; the draft deduplicates, redacts and is never sent", async () => {
  const dir = tmp("fs-fb-");
  const cfg = loadConfig(envFor(dir));
  const s = loadState(cfg.dataDir);
  await scan(s, cfg, { capture: null });
  const log = readLog(dir);
  assert.ok(log.some((e) => e.kind === "unreadable_source" && e.url?.includes("x.com")));
  assert.ok(log.some((e) => e.kind === "unreadable_source" && /paywall/.test(e.detail)));
  logEvent(dir, { kind: "api_error", code: "rate_limited", detail: "POST /submissions: too many requests (Bearer abc123secret)" });
  logEvent(dir, { kind: "api_error", code: "rate_limited", detail: "POST /submissions: too many requests (Bearer zzz999secret)" });
  assert.ok(!fs.readFileSync(feedbackLogPath(dir), "utf8").includes("abc123secret"), "credentials redacted before writing");
  assert.equal(redact("api_key=xyz token: t0k"), "api_key=[redacted] token: [redacted]");
  // verdict rationales: pulled from synced submissions, each logged once
  const st = emptyState();
  st.submissions.push({ id: "sub_x1", market: "0xm", itemId: null, note: "n", links: ["https://x.com/a/1"], status: "judged", verdict: "rejected", reason: "Could not read the linked page.", bounty: null, createdAt: "", updatedAt: "" });
  st.submissions.push({ id: "sub_x2", market: "0xm", itemId: null, note: "n", links: ["https://x.com/a/2"], status: "judged", verdict: "rejected", reason: "Could not read the linked page.", bounty: null, createdAt: "", updatedAt: "" });
  assert.equal(logVerdicts(dir, st), 2);
  assert.equal(logVerdicts(dir, st), 0, "not logged twice");
  st.feedback.push({ at: "2026-11-22T00:00:00Z", category: "docs", text: "Which hosts can the judge fetch?" }, { at: "2026-11-23T00:00:00Z", category: "docs", text: "Which hosts can the judge fetch?" });
  const md = draftFeedbackMarkdown(readLog(dir), st.feedback);
  assert.match(md, /NOT SENT/);
  assert.match(md, /Judge rejected \(unreadable\)\*\* \(2x/, "two identical rationales -> one note");
  assert.match(md, /API error rate_limited\*\* \(2x/, "same error with different tokens -> one note");
  assert.equal((md.match(/Which hosts can the judge fetch\?/g) ?? []).length, 1, "manual notes deduplicated");
  assert.ok(!md.includes("secret"));
});

test("feedback draft CLI writes a markdown file and sends nothing", () => {
  const dir = tmp("fs-fbcli-");
  logEvent(dir, { kind: "fetch_failure", detail: "HTTP 403", url: "https://www.opec.org/x" });
  const env = { ...process.env, ...envFor(dir), DELPHI_API_URL: "http://127.0.0.1:9/v1" }; // unreachable: proves no API call is needed
  const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "feedback", "draft"], { env, encoding: "utf8" });
  assert.match(out, /Nothing was sent/);
  const md = fs.readFileSync(path.join(dir, "feedback-draft.md"), "utf8");
  assert.match(md, /opec\.org/);
});

// ---------- 4. curated sources + feeds ----------

test("config/sources.json: valid regexes, https URLs, a type for each, no duplicates, global coverage", () => {
  const c = JSON.parse(fs.readFileSync("config/sources.json", "utf8"));
  const all = [...c.official, ...c.calendars];
  assert.ok(all.length >= 50);
  const seen = new Set<string>();
  for (const e of all) {
    assert.doesNotThrow(() => new RegExp(e.match, "i"), e.label);
    assert.match(e.url, /^https:\/\//);
    assert.ok(["rss", "page", "calendar"].includes(e.type), e.label);
    const key = `${e.url}|${e.type}`;
    assert.ok(!seen.has(key), `duplicate ${e.url}`);
    seen.add(key);
  }
  for (const t of ["macro", "crypto", "tech", "sports", "politics"]) assert.ok(all.some((e) => e.topic === t), t);
  for (const r of c.regional) for (const u of r.urls) assert.match(u, /^https:\/\//);
});

test("sources: questions map to the right official sources and calendars", () => {
  const cfg = loadSourcesConfig("config/sources.json");
  const urls = (q: string) => planSources({ address: "0x", question: q, status: "open", odds: { yes: 0.5, no: 0.5 }, evidenceCutoffAt: "", dataSources: [] }, cfg).sources.map((s) => s.url);
  assert.ok(urls("Will US CPI inflation for November 2026 be above 3.0%?").some((u) => u.includes("bls.gov")));
  assert.ok(urls("Will the Fed cut rates at the December 2026 FOMC meeting?").some((u) => u.includes("fomccalendars")));
  assert.ok(urls("Will the ECB cut its deposit rate in December 2026?").some((u) => u.includes("ecb.europa.eu")));
  assert.ok(urls("Will Nigeria's inflation rate fall below 15% in November 2026?").some((u) => u.includes("nigerianstat.gov.ng")));
  assert.ok(urls("Will the Bank of Japan raise rates in December 2026?").some((u) => u.includes("boj.or.jp")));
  assert.ok(urls("Will Apple announce a foldable iPhone before 2027?").some((u) => u.includes("apple.com")));
  assert.ok(urls("Will the SEC approve a spot Solana ETF by 2026-12-31?").some((u) => u.includes("sec.gov")));
  assert.ok(urls("Who will win the 2026 Abu Dhabi Grand Prix?").some((u) => u.includes("formula1.com")));
  const btc = urls("Will Bitcoin close above $150,000 on 2026-12-31?");
  assert.ok(!btc.some((u) => u.includes("bls.gov")), "no US macro sources for a crypto price question");
  assert.ok(btc.some((u) => u.includes("coindesk.com")));
});

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Mock Statistics Office releases</title>
<item><title>Consumer Price Index, October 2026</title><link>https://stats.example.org/cpi/2026-10</link><pubDate>Thu, 13 Nov 2026 13:30:00 GMT</pubDate>
<description><![CDATA[<p>Consumer price inflation rose to 3.2% in October 2026, the Statistics Office reported.</p>]]></description></item>
<item><title>Labour market</title><link>https://stats.example.org/lm</link><pubDate>Fri, 06 Nov 2026 13:30:00 GMT</pubDate><description>Unemployment fell to 4.8%.</description></item>
</channel></rss>`;
const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Mock blog</title>
<entry><title>Vega-2 static fire complete</title><link rel="alternate" href="https://blog.example.org/vega2"/><updated>2026-11-17T10:00:00Z</updated><summary type="html">&lt;p&gt;Orion Aerospace completed the Vega-2 static fire with 9 engines.&lt;/p&gt;</summary></entry></feed>`;

test("feeds: RSS and Atom items are parsed; facts cite the ITEM link and item date, not the feed", () => {
  assert.ok(isFeed({ contentType: "application/rss+xml", body: RSS }));
  assert.ok(isFeed({ contentType: "text/xml", body: ATOM }));
  assert.ok(!isFeed({ contentType: "text/html", body: "<html><body>x</body></html>" }));
  const r = parseFeed(RSS);
  assert.equal(r.title, "Mock Statistics Office releases");
  assert.equal(r.items.length, 2);
  assert.deepEqual([r.items[0].link, r.items[0].date], ["https://stats.example.org/cpi/2026-10", "2026-11-13"]);
  assert.match(r.items[0].text, /rose to 3\.2%/);
  const a = parseFeed(ATOM);
  assert.deepEqual([a.items[0].link, a.items[0].date], ["https://blog.example.org/vega2", "2026-11-17"]);
  const m: MarketCard = { address: "0xA1", question: "Will the Statistics Office report November 2026 CPI inflation above 3.0%?", status: "open", odds: { yes: 0.5, no: 0.5 }, evidenceCutoffAt: "2026-12-20T00:00:00Z", dataSources: [] };
  const ex = extractFacts(m, { url: "https://stats.example.org/feed.rss", kind: "primary" }, { ok: true, status: 200, url: "https://stats.example.org/feed.rss", finalUrl: "https://stats.example.org/feed.rss", contentType: "application/rss+xml", body: RSS }, Date.parse("2026-11-22T00:00:00Z"));
  const f = ex.facts.find((x) => x.text.includes("3.2%"))!;
  assert.ok(f, "fact from the feed item");
  assert.equal(f.source, "https://stats.example.org/cpi/2026-10");
  assert.equal(f.publisher, "Mock Statistics Office releases");
});

test("preflight: an RSS/Atom content type is readable (it was refused before)", async () => {
  const body = RSS.replace("</channel>", `${"<item><title>Filler</title><description>Methodology notes and revision policy are on the methodology page for the public record.</description></item>".repeat(6)}</channel>`);
  const f: typeof fetch = async () => new Response(body, { status: 200, headers: { "content-type": "application/rss+xml; charset=utf-8" } });
  const r = await preflight("https://stats.example.org/feed.rss", "Consumer price inflation rose to 3.2% in October 2026", { fetch: f });
  assert.equal(r.readable, true, r.reasons.join("; "));
});

// ---------- agent headers ----------

test("agent headers: ID, harness and model are configurable, validated, and safe to print", () => {
  const c = loadConfig({ AGENT_ID: "fs-mzee", AGENT_HARNESS: "firstsource/0.2 custom", AGENT_MODEL: "none" });
  assert.deepEqual([c.agentId, c.agentHarness, c.agentModel], ["fs-mzee", "firstsource/0.2 custom", "none"]);
  assert.match(loadConfig({}).agentHarness, /^firstsource\/0\.3/);
  assert.throws(() => loadConfig({ AGENT_HARNESS: "x".repeat(65) }), /AGENT_HARNESS/);
  assert.throws(() => loadConfig({ FIRSTSOURCE_SCREENSHOT: "maybe" }), /FIRSTSOURCE_SCREENSHOT/);
  assert.throws(() => loadConfig({ FIRSTSOURCE_MAX_ATTEMPTS: "9" }), /FIRSTSOURCE_MAX_ATTEMPTS/);
  const d = JSON.stringify(describeConfig(loadConfig({ DELPHI_API_ACCESS_KEY: "k-secret-1" })));
  assert.ok(!d.includes("k-secret-1"));
});

test("sync logs verdict rationales against the mock without sending anything", async () => {
  const dir = tmp("fs-syncfb-");
  const cfg = loadConfig(envFor(dir));
  const s = loadState(cfg.dataDir);
  const before = mock.stats.submitCalls;
  await sync(s, makeClient(cfg));
  // wait for the mock's toy judge: poll each submission once more via sync after getSubmission
  const client = makeClient(cfg);
  for (const x of mock.subs) await client.getSubmission(x.id).catch(() => null);
  for (const x of mock.subs) await client.getSubmission(x.id).catch(() => null);
  await sync(s, client);
  const n = logVerdicts(dir, s);
  assert.ok(n >= 1, "at least one judged submission logged");
  assert.equal(mock.stats.submitCalls, before, "sync and logging never POST");
});
