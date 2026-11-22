// Regression tests for the bugs found in the 20 Nov code review. Local mock only; no real network or API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { startMock, MOCK_KEY, type Mock } from "../mock/server.ts";
import { item, state, sub } from "./helpers.ts";
import { headerValue, intEnv, loadConfig } from "../src/config.ts";
import { makeClient, withTimeout } from "../src/api.ts";
import { acquireLock, loadState, saveState } from "../src/store.ts";
import { approvalWarnings, approve, attach, getItem, reject } from "../src/queue.ts";
import { cutoffCheck, lockedSide, sideCheck } from "../src/rules.ts";
import { preflight } from "../src/preflight.ts";
import { normalizeMarket, scan } from "../src/scan.ts";
import { extractFacts } from "../src/extract.ts";
import { localChecks, submitItem, sync } from "../src/submit.ts";
import type { MarketCard } from "../src/types.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("config: junk numbers fail loudly instead of becoming NaN (NaN disabled the per-market budget and note cap)", () => {
  assert.throws(() => loadConfig({ FIRSTSOURCE_PER_MARKET: "two" }), /FIRSTSOURCE_PER_MARKET/);
  assert.throws(() => loadConfig({ FIRSTSOURCE_NOTE_MAX: "abc" }), /FIRSTSOURCE_NOTE_MAX/);
  assert.throws(() => loadConfig({ FIRSTSOURCE_PER_MARKET: "9" }), /between 1 and 3/);
  const c = loadConfig({});
  assert.equal(c.perMarket, 2);
  assert.equal(c.noteMax, 1200);
  assert.equal(intEnv(" ", 5, "X"), 5);
});

test("config: agent headers are 1-64 printable ASCII and a model is always sent", () => {
  assert.throws(() => loadConfig({ AGENT_ID: "x".repeat(65) }), /AGENT_ID/);
  assert.throws(() => headerValue("caf\u00e9", undefined, "AGENT_MODEL"), /AGENT_MODEL/);
  assert.ok(loadConfig({}).agentModel);
});

test("api: a stalled request times out instead of hanging forever", async () => {
  const hang: typeof fetch = (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
  const f = withTimeout(hang, 50);
  await assert.rejects(f("http://127.0.0.1:1/x"), /timeout|aborted/i);
  const client = makeClient({ ...loadConfig({}), apiUrl: "http://127.0.0.1:1/v1", apiKey: "k" }, hang, 50);
  await assert.rejects(client.getTerms(), /timeout|aborted/i);
});

test("store: a second run on the same data dir is refused; a dead run's lock is reclaimed", () => {
  const d = tmp("fs-lock-");
  const release = acquireLock(d);
  assert.throws(() => acquireLock(d, process.pid + 1), /another FirstSource run/);
  release();
  fs.writeFileSync(path.join(d, ".lock"), "999999999"); // no such pid
  const r2 = acquireLock(d);
  r2();
  assert.ok(!fs.existsSync(path.join(d, ".lock")));
});

test("store: a corrupt state file gives a clear error and a .bak is kept on save", () => {
  const d = tmp("fs-state-");
  const s = state();
  saveState(d, s);
  saveState(d, s);
  assert.ok(fs.existsSync(path.join(d, "state.json.bak")));
  fs.writeFileSync(path.join(d, "state.json"), "{oops");
  assert.throws(() => loadState(d), /not valid JSON/);
});

test("queue: an ambiguous or too-short id prefix is an error, never a guess", () => {
  const s = state();
  const a = item("0xM", "fact a 1%", "YES"), b = item("0xM", "fact b 2%", "YES");
  a.id = "abcd1111"; b.id = "abcd2222";
  s.items.push(a, b);
  assert.throws(() => getItem(s, "abcd"), /matches 2 items/);
  assert.throws(() => getItem(s, "ab"), /at least 4/);
  assert.throws(() => getItem(s, ""), /missing item id/);
  assert.equal(getItem(s, "abcd2").id, "abcd2222");
});

test("queue: attach refuses directories, empty files and types the FAQ does not list", () => {
  const s = state();
  const a = item("0xM", "fact 1%", "YES");
  s.items.push(a);
  const d = tmp("fs-attach-");
  assert.throws(() => attach(s, a.id, d), /no file/);
  fs.writeFileSync(path.join(d, "page.html"), "<p>x</p>");
  assert.throws(() => attach(s, a.id, path.join(d, "page.html")), /not accepted/);
  fs.writeFileSync(path.join(d, "empty.png"), "");
  assert.throws(() => attach(s, a.id, path.join(d, "empty.png")), /empty/);
  fs.writeFileSync(path.join(d, "shot.png"), "png");
  assert.equal(attach(s, a.id, path.join(d, "shot.png")).files.length, 1);
});

test("side lock: un-approving the only approved item releases the market's side", () => {
  const s = state();
  const a = item("0xM", "rate rose to 3.2%", "YES");
  const b = item("0xM", "levy vote failed 2-7", "NO");
  s.items.push(a, b);
  approve(s, a.id);
  assert.equal(lockedSide(s, "0xM"), "YES");
  assert.throws(() => approve(s, b.id), /locked to YES/);
  reject(s, a.id, "changed my mind");
  assert.equal(lockedSide(s, "0xM"), null);
  approve(s, b.id);
  assert.equal(lockedSide(s, "0xm"), "NO");
});

test("side lock: survives a lost state file via the side written in synced notes", () => {
  const s = state();
  s.submissions.push(sub("0xM", "judged", { note: "As of 2026-11-26: x\nRelevance: this dated fact bears on \"Q\" and points toward NO." }));
  assert.equal(lockedSide(s, "0xm"), "NO");
  assert.equal(sideCheck(s, "0xM", "YES").ok, false);
});

test("cutoff: the evidence cutoff is the submission deadline (FAQ); approve and submit refuse after it", () => {
  const s = state();
  const a = item("0xM", "rate rose to 3.2%", "YES");
  a.cutoffAt = "2026-11-30T17:00:00Z";
  s.items.push(a);
  const after = Date.parse("2026-12-01T00:00:00Z");
  assert.throws(() => approve(s, a.id, after), /cutoff .* has passed/);
  approve(s, a.id, Date.parse("2026-11-29T00:00:00Z"));
  assert.ok(localChecks(s, a, undefined, after).some((e) => /cutoff/.test(e)));
  assert.equal(cutoffCheck({ cutoffAt: undefined }).ok, true);
});

test("approval warnings: fallback item without a screenshot is flagged", () => {
  const a = item("0xM", "x 1%", "YES");
  a.mode = "fallback";
  a.files = ["/tmp/cap.pdf"];
  assert.ok(approvalWarnings(a).some((w) => /screenshot/.test(w)));
  a.files.push("/tmp/shot.png");
  assert.ok(!approvalWarnings(a).some((w) => /screenshot/.test(w)));
});

test("preflight: a 200 HTML page with an empty body is NOT readable", async () => {
  const f: typeof fetch = async () => new Response("", { status: 200, headers: { "content-type": "text/html" } });
  const r = await preflight("https://example.org/empty", "key text", { fetch: f });
  assert.equal(r.readable, false);
  assert.ok(r.reasons.some((x) => /only 0 chars/.test(x)));
});

test("markets.json: malformed entries are dropped; a string dataSources is not split into characters", () => {
  assert.equal(normalizeMarket(null), null);
  assert.equal(normalizeMarket({ address: "0x1", question: "Q?", odds: { yes: "abc" } }), null);
  assert.equal(normalizeMarket({ address: "", question: "Q?", odds: { yes: 0.5 } }), null);
  const m = normalizeMarket({ address: " 0x1 ", question: "Q?", status: "open", odds: { yes: "0.5", no: 0.5 }, evidenceCutoffAt: "2026-12-01T00:00:00Z", dataSources: "https://example.org/src" })!;
  assert.deepEqual(m.dataSources, ["https://example.org/src"]);
  assert.equal(m.address, "0x1");
  assert.equal(m.odds.yes, 0.5);
  assert.deepEqual(normalizeMarket({ address: "0x1", question: "Q?", odds: { yes: 0.5 }, dataSources: [1, "", "https://a.org"] })!.dataSources, ["https://a.org"]);
});

test("extract: cutoff with a UTC offset is compared in UTC", () => {
  const m: MarketCard = { address: "0x1", question: "Will Mockland CPI inflation be above 3%?", status: "open", odds: { yes: 0.5, no: 0.5 }, evidenceCutoffAt: "2026-11-14T01:00:00+05:00", dataSources: [] };
  const body = "<p>Mockland CPI inflation rose to 3.2% in October 2026, the office said on 2026-11-14.</p>";
  const ex = extractFacts(m, { url: "https://e.org", kind: "official" }, { ok: true, status: 200, url: "https://e.org", finalUrl: "https://e.org", contentType: "text/html", body }, Date.parse("2026-11-20T00:00:00Z"));
  assert.equal(ex.facts.length, 0, "cutoff is 2026-11-13 20:00 UTC, so a 2026-11-14 fact is after it");
});

let mock: Mock;
let src: string;
before(async () => {
  mock = await startMock(0);
  src = path.join(tmp("fs-rv-"), "sources.json");
  fs.writeFileSync(src, JSON.stringify({ calendars: [], regional: [{ place: "Northport", urls: [`${mock.url}/src/northport/news`] }] }));
});
after(async () => { await mock.close(); });
const envFor = (dir: string, extra: Record<string, string> = {}) => ({ COMPETITION_SITE_URL: mock.url, DELPHI_API_URL: mock.apiUrl, DELPHI_API_ACCESS_KEY: MOCK_KEY, FIRSTSOURCE_DATA_DIR: dir, FIRSTSOURCE_SOURCES: src, ...extra });

test("scan: a previously rejected fact is not re-fetched for preflight or re-captured", async () => {
  const cfg = loadConfig(envFor(tmp("fs-rescan-")));
  const s = loadState(cfg.dataDir);
  await scan(s, cfg);
  for (const i of s.items) reject(s, i.id, "no");
  const calls: string[] = [];
  const counting: typeof fetch = (u, init) => { calls.push(String(u)); return fetch(u, init); };
  const r = await scan(s, cfg, { fetch: counting });
  assert.equal(r.added.length, 0);
  const perUrl = new Map<string, number>();
  for (const c of calls) perUrl.set(c, (perUrl.get(c) ?? 0) + 1);
  assert.ok([...perUrl.values()].every((n) => n === 1), "each source fetched once, no preflight re-fetch");
});

test("live: a submit that landed but was never recorded is reconciled, not re-sent", async () => {
  const cfg = loadConfig(envFor(tmp("fs-land-"), { FIRSTSOURCE_LIVE: "1" }));
  const s = loadState(cfg.dataDir);
  await scan(s, cfg);
  const it = s.items.find((i) => i.side && i.mode === "link" && i.files.length === 0)!;
  approve(s, it.id);
  const raw = new EvidenceClient({ baseUrl: mock.apiUrl, apiKey: MOCK_KEY });
  if (!mock.terms.acceptedAt) await raw.acceptTerms(mock.terms.version); // mock only: owner accepted out of band
  // the first attempt "timed out" after the server saved it
  const landed = await raw.submitEvidence({ note: it.note, links: it.links, marketAddress: it.market, idempotencyKey: it.idempotencyKey });
  assert.equal(it.status, "approved");
  const before = mock.stats.submitCalls;
  const o = await submitItem(s, cfg, it.id, { live: true, client: makeClient(cfg), wait: false });
  assert.equal(mock.stats.submitCalls, before, "nothing re-sent");
  assert.equal(o.submissionId, landed.data.id);
  assert.equal(o.alreadyLanded, true);
  assert.equal(it.status, "submitted");
  // a plain sync also reconciles
  const s2 = loadState(tmp("fs-land2-"));
  const it2 = { ...it, status: "approved" as const, submissionId: undefined };
  s2.items.push(it2);
  await sync(s2, makeClient(cfg));
  assert.equal(it2.status, "submitted");
  assert.equal(it2.submissionId, landed.data.id);
});

test("live: the same fact already sent by another run on this account is blocked before sending", async () => {
  const cfg = loadConfig(envFor(tmp("fs-other-"), { FIRSTSOURCE_LIVE: "1" }));
  const s = loadState(cfg.dataDir);
  await scan(s, cfg);
  const it = s.items.find((i) => i.side && i.market.endsWith("c2"))!; // Northport levy market
  assert.ok(it, "northport candidate");
  approve(s, it.id);
  const raw = new EvidenceClient({ baseUrl: mock.apiUrl, apiKey: MOCK_KEY });
  if (!mock.terms.acceptedAt) await raw.acceptTerms(mock.terms.version);
  await raw.submitEvidence({ note: `As of ${it.fact.date}: ${it.fact.text}\n(sent from another machine)`, links: it.links, marketAddress: it.market });
  const before = mock.stats.submitCalls;
  await assert.rejects(submitItem(s, cfg, it.id, { live: true, client: makeClient(cfg), wait: false }), /duplicate of submission/);
  assert.equal(mock.stats.submitCalls, before);
});
