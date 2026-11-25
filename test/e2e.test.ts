// Full dry run + mock-live run against the local mock server. No real network, no real API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { startMock, MOCK_KEY, type Mock } from "../mock/server.ts";
import { loadConfig, describeConfig } from "../src/config.ts";
import { loadState, saveState } from "../src/store.ts";
import { scan } from "../src/scan.ts";
import { approve, getItem, reject } from "../src/queue.ts";
import { filesFor, submitItem, sync } from "../src/submit.ts";
import { attach } from "../src/queue.ts";
import { makeClient } from "../src/api.ts";
import { qualification } from "../src/tracker.ts";
import { MAX_FILES } from "../src/rules.ts";

let mock: Mock;
let dir: string;
const env = () => ({
  COMPETITION_SITE_URL: mock.url,
  DELPHI_API_URL: mock.apiUrl,
  DELPHI_API_ACCESS_KEY: MOCK_KEY,
  FIRSTSOURCE_DATA_DIR: dir,
  FIRSTSOURCE_SOURCES: path.join(dir, "sources.json"),
  FIRSTSOURCE_SCREENSHOT: "off", // tests never launch a browser; screenshots are attached as files
});
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

before(async () => {
  mock = await startMock(0);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-e2e-"));
  fs.writeFileSync(path.join(dir, "sources.json"), JSON.stringify({
    calendars: [{ match: "CPI|inflation", url: `${mock.url}/src/stats/calendar` }],
    regional: [{ place: "Northport", urls: [`${mock.url}/src/northport/news`] }],
  }));
});
after(async () => { await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("config never exposes the key", () => {
  const d = JSON.stringify(describeConfig(loadConfig(env())));
  assert.ok(!d.includes(MOCK_KEY));
  assert.match(d, /"apiKey":"\(set\)"/);
});

test("end to end: scan -> review -> dry run -> gated live -> judged -> sync -> tracker", async () => {
  const cfg = loadConfig(env());
  const state = loadState(cfg.dataDir);

  // scan (parts 1-8)
  const r = await scan(state, cfg);
  saveState(cfg.dataDir, state);
  assert.equal(r.picks.length, 5, "5 open, uncertain, pre-cutoff markets");
  assert.ok(new Set(r.added.map((i) => i.market)).size >= 3, "spread across >= 3 markets");
  assert.ok(r.unresolvedSources.some((u) => u.sources[0].includes("City Clerk")));
  assert.ok(r.skipped.some((s) => s.why.includes("x.com")), "X link not fetched");
  assert.ok(r.watchesAdded >= 2, "calendar + scheduled items watched");
  const cpi = r.added.find((i) => i.fact.text.includes("3.2%"))!;
  assert.equal(cpi.side, "YES");
  assert.equal(cpi.mode, "link");
  const orion = r.added.find((i) => i.fact.text.includes("Vega-2"))!;
  assert.equal(orion.mode, "fallback", "paywalled page -> pasted text + screenshot required");
  assert.equal(orion.files.length, 0, "no text-PDF: note + link leave room for one screenshot");
  assert.equal(orion.requiresScreenshot, true, "paywall -> hard-to-fetch -> screenshot required");
  assert.match(orion.note, /Key text \(quoted from the source/);
  assert.match(orion.note, /dated screenshot showing the URL and capture date/);
  const regional = r.added.find((i) => i.fact.sourceKind === "regional");
  assert.ok(regional, "regional source used for the place market");

  // rescan adds nothing new (novelty)
  const r2 = await scan(state, cfg);
  assert.equal(r2.added.length, 0);

  // nothing approved -> nothing can be submitted, even dry
  await assert.rejects(submitItem(state, cfg, cpi.id), /not approved/);

  // the paywalled item cannot be approved until a dated screenshot is attached
  assert.throws(() => approve(state, orion.id), /needs a dated screenshot/);
  const shot = path.join(dir, "orion-shot.png");
  fs.writeFileSync(shot, PNG_1PX);
  attach(state, orion.id, shot);

  // approve all with a side; dry run sends nothing to POST /submissions
  for (const i of state.items) if (i.side) approve(state, i.id);
  const approved = state.items.filter((i) => i.status === "approved");
  assert.ok(approved.length >= 4);
  for (const i of approved) {
    const o = await submitItem(state, cfg, i.id);
    assert.equal(o.mode, "dry-run");
    const req = JSON.parse(fs.readFileSync(o.dryRunFile!, "utf8"));
    assert.equal(req.params.idempotencyKey, i.idempotencyKey);
    assert.ok(req.params.files.length <= MAX_FILES);
  }
  assert.equal(mock.stats.submitCalls, 0, "dry run never hits POST /submissions");

  // live without FIRSTSOURCE_LIVE=1 is refused
  const client = makeClient(cfg);
  await assert.rejects(submitItem(state, cfg, cpi.id, { live: true, client }), /FIRSTSOURCE_LIVE is not 1/);
  const liveCfg = loadConfig({ ...env(), FIRSTSOURCE_LIVE: "1" });
  // terms not accepted -> refused before any submit; FirstSource never calls acceptTerms itself
  await assert.rejects(submitItem(state, liveCfg, cpi.id, { live: true, client }), /terms .* not accepted/);
  assert.equal(mock.stats.submitCalls, 0);
  assert.equal(mock.stats.acceptCalls, 0);

  // (mock only) the account owner accepts terms out of band
  await new EvidenceClient({ baseUrl: mock.apiUrl, apiKey: MOCK_KEY }).acceptTerms(mock.terms.version);

  // live to the mock: judged
  const outs = [];
  for (const i of approved) outs.push(await submitItem(state, liveCfg, i.id, { live: true, client, timeoutMs: 20_000 }));
  saveState(cfg.dataDir, state);
  assert.ok(outs.every((o) => o.status === "judged"));
  const orionOut = outs.find((o) => o.itemId === orion.id)!;
  assert.equal(orionOut.verdict, "accepted", "fallback capture made the paywalled fact readable to the (mock) judge");
  assert.equal(mock.subs.find((s) => s.id === orionOut.submissionId)!.files.length, 1, "dated screenshot only (3-item cap)");
  // agent ID / harness / model headers reach the API on every submit
  assert.ok(mock.stats.agentHeaders.length > 0);
  for (const h of mock.stats.agentHeaders) {
    assert.equal(h.id, "firstsource");
    assert.match(h.harness, /^firstsource\/0\.3/);
    assert.equal(h.model, "rule-based (no LLM)");
  }

  // re-submitting a submitted item is blocked locally
  await assert.rejects(submitItem(state, liveCfg, cpi.id, { live: true, client }), /not approved/);

  // idempotency at the API: same key + same body returns the same submission
  const sub = mock.subs[0];
  const it = state.items.find((i) => i.submissionId === sub.id)!;
  const again = await client.submitEvidence({ note: it.note, links: it.links, marketAddress: it.market, idempotencyKey: it.idempotencyKey, files: filesFor(it) });
  assert.equal(again.data.id, sub.id);

  // sync pulls verdicts; tracker sees judged across >= 3 markets
  const s = await sync(state, client);
  assert.equal(s.fetched, mock.subs.length);
  const q = qualification(state);
  assert.equal(q.judged, approved.length);
  assert.ok(q.judgedMarkets >= 3);
  assert.equal(q.qualified, false, "fewer than 10 judged");
});

test("server-side cap: a 4th submit on one market is refused before sending", async () => {
  const cfg = loadConfig({ ...env(), FIRSTSOURCE_LIVE: "1", FIRSTSOURCE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fs-cap-")) });
  const state = loadState(cfg.dataDir);
  const client = makeClient(cfg);
  const market = "0xA5000000000000000000000000000000000000c5"; // unemployment market
  // fill the market on the server from "another run" (2 already there from e2e? count them)
  const existing = mock.subs.filter((x) => x.market === market).length;
  for (let k = existing; k < 3; k++) await client.submitEvidence({ note: `As of 2026-11-0${k + 1}: filler fact ${k} at ${k}.0%`, links: [`${mock.url}/src/labour/release`], marketAddress: market });
  const st = await client.getEntryState(market);
  assert.equal(st.data.remainingOnMarket, 0);
  // a fresh local state does not know about them until sync -> the live path still asks entry-state first
  const r = await scan(state, cfg);
  const cand = state.items.find((i) => i.market === market && i.side);
  assert.ok(cand, "scan found a candidate for the full market");
  assert.ok(r.picks.some((p) => p.market.address === market), "picker does not know the server count before sync");
  approve(state, cand.id);
  const before = mock.stats.submitCalls;
  // The live path first pulls this account's submissions on the market. The e2e run above already sent
  // this exact note from "another state file", so it is reconciled as already landed; otherwise the
  // full market is refused by entry state / cap. Either way nothing is sent.
  const res = await submitItem(state, cfg, cand.id, { live: true, client }).then((o) => o, (e: Error) => e);
  assert.equal(mock.stats.submitCalls, before, "nothing sent");
  if (res instanceof Error) assert.match(res.message, /entry state|cap reached|duplicate/);
  else assert.equal(res.alreadyLanded, true);
  await sync(state, client);
  assert.ok(state.submissions.filter((x) => x.market === market).length >= 3);
});

test("reviewer reject keeps the item out for good", async () => {
  const cfg = loadConfig({ ...env(), FIRSTSOURCE_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "fs-rej-")) });
  const state = loadState(cfg.dataDir);
  await scan(state, cfg);
  const i = state.items[0];
  reject(state, i.id, "weak");
  assert.equal(getItem(state, i.id).status, "rejected");
  await assert.rejects(submitItem(state, cfg, i.id), /not approved/);
});
