import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { item, state, sub } from "./helpers.ts";
import { checkNovelty, fingerprint, nearDuplicate } from "../src/novelty.ts";
import { capCheck, countsTowardMarketCap, countsTowardQualification, itemCount, itemsCheck, lockedSide, sideCheck, usedSlots } from "../src/rules.ts";
import { approve, attach, reject, setSide } from "../src/queue.ts";
import { qualification, addFeedback, feedbackMarkdown } from "../src/tracker.ts";
import { learn, outcomeOf, tagReason } from "../src/learn.ts";
import { pickMarkets } from "../src/picker.ts";
import type { MarketCard } from "../src/types.ts";

const M1 = "0xMarket1", M2 = "0xMarket2", M3 = "0xMarket3";

// ---- dedup / novelty
test("dedup: same fact with a different date format is a duplicate", () => {
  assert.equal(fingerprint("CPI rose to 3.2% on Nov 13, 2026."), fingerprint("cpi rose to 3.2% on 2026-11-13"));
});
test("dedup: different figure is a different fact", () => {
  assert.equal(nearDuplicate("CPI rose to 3.2% in October", "CPI rose to 3.4% in October"), false);
});
test("dedup: near-duplicate wording with same figures is caught", () => {
  assert.equal(nearDuplicate("Consumer price inflation rose to 3.2% in October 2026, the office said", "Consumer price inflation rose to 3.2% in October 2026, the office said today"), true);
});
test("dedup: blocks a fact already queued on the same market, warns across markets", () => {
  const s = state();
  s.items.push(item(M1, "Inflation rose to 3.2% in October 2026.", "YES"));
  assert.equal(checkNovelty(s, M1, "inflation rose to 3.2% in October 2026").novel, false);
  const other = checkNovelty(s, M2, "inflation rose to 3.2% in October 2026");
  assert.equal(other.novel, true);
  assert.ok(other.crossMarket);
});
test("dedup: rejected items do not block; submission notes (incl. listSubmissions) do", () => {
  const s = state();
  s.items.push(item(M1, "The council approved the levy 7-2.", "YES", "rejected"));
  assert.equal(checkNovelty(s, M1, "The council approved the levy 7-2.").novel, true);
  s.submissions.push(sub(M1, "judged", { note: "As of 2026-11-18: The council approved the levy 7-2.\nSource: x" }));
  assert.equal(checkNovelty(s, M1, "The council approved the levy 7-2.").novel, false);
});

// ---- one side per market
test("one-side: approving the opposite side of a locked market is refused", async () => {
  const s = state();
  const a = item(M1, "Inflation rose to 3.2% in October.", "YES");
  const b = item(M1, "Core inflation fell to 2.1% in October.", "NO");
  s.items.push(a, b);
  await approve(s, a.id);
  assert.equal(lockedSide(s, M1), "YES");
  await assert.rejects(async () => await approve(s, b.id), /locked to YES/);
  assert.equal(sideCheck(s, M2, "NO").ok, true);
});
test("one-side: no side -> cannot approve until a reviewer sets one", async () => {
  const s = state();
  const a = item(M1, "Something happened with 3 figures.", null);
  s.items.push(a);
  await assert.rejects(async () => await approve(s, a.id), /no side/);
  setSide(s, a.id, "NO");
  assert.equal((await approve(s, a.id)).status, "approved");
});
test("one-side: lock survives even when the approved item is later submitted", () => {
  const s = state();
  const a = item(M1, "Inflation rose to 3.2%.", "YES", "submitted");
  s.items.push(a);
  assert.equal(sideCheck(s, M1, "NO").ok, false);
});

// ---- per-market cap
test("cap: max 3 per market counting submitted + approved (reserved)", async () => {
  const s = state();
  s.submissions.push(sub(M1, "judged"), sub(M1, "queued"));
  const a = item(M1, "Fact A 1.1% rose", "YES"), b = item(M1, "Fact B 2.2% rose", "YES");
  s.items.push(a, b);
  await approve(s, a.id);
  assert.equal(usedSlots(s, M1), 3);
  await assert.rejects(async () => await approve(s, b.id), /cap reached/);
  assert.equal(capCheck(s, M2).remaining, 3);
});
test("cap: server remainingOnMarket wins when lower", () => {
  const s = state();
  assert.equal(capCheck(s, M1, { remoteRemaining: 0 }).ok, false);
  assert.equal(capCheck(s, M1, { remoteRemaining: 1 }).remaining, 1);
});
test("cap: market picker skips full markets and spreads over >= 3 markets", () => {
  const now = Date.parse("2026-11-26T00:00:00Z");
  const mk = (a: string, yes: number, extra: Partial<MarketCard> = {}): MarketCard => ({ address: a, question: `q ${a}`, status: "open", odds: { yes, no: 1 - yes }, evidenceCutoffAt: "2026-12-10T00:00:00Z", dataSources: ["https://e.org"], ...extra });
  const s = state();
  s.submissions.push(sub(M1, "judged"), sub(M1, "judged"), sub(M1, "judged"));
  const picks = pickMarkets([mk(M1, 0.5), mk(M2, 0.5), mk(M3, 0.6), mk("0x4", 0.45), mk("0x5", 0.99), mk("0x6", 0.5, { status: "resolved" }), mk("0x7", 0.5, { evidenceCutoffAt: "2026-11-01T00:00:00Z" })], s, { now });
  const addrs = picks.map((p) => p.market.address);
  assert.ok(!addrs.includes(M1), "full market skipped");
  assert.ok(!addrs.includes("0x5") && !addrs.includes("0x6") && !addrs.includes("0x7"));
  assert.ok(new Set(addrs).size >= 3);
});

// ---- qualification tracker
test("tracker: 10 judged across 3 markets qualifies; 10 on 2 markets does not", () => {
  const s = state();
  for (let i = 0; i < 3; i++) s.submissions.push(sub(M1, "judged"), sub(M2, "judged"));
  for (let i = 0; i < 4; i++) s.submissions.push(sub(M2 + i, "judged"));
  let q = qualification(s);
  assert.equal(q.judged, 10);
  assert.equal(q.qualified, true);
  const t = state();
  for (let i = 0; i < 5; i++) t.submissions.push(sub(M1, "judged"), sub(M2, "judged"));
  q = qualification(t);
  assert.equal(q.qualified, false);
  assert.equal(q.needMarkets, 1);
});
test("tracker: queued/judging/rejected do not count as judged", () => {
  const s = state();
  s.submissions.push(sub(M1, "queued"), sub(M2, "judging"), sub(M3, "rejected"), sub(M3, "judged"));
  const q = qualification(s);
  assert.equal(q.judged, 1);
  assert.equal(q.pending, 2);
  assert.equal(q.needJudged, 9);
});
test("tracker: feedback log validates category and exports markdown", () => {
  const s = state();
  assert.throws(() => addFeedback(s, "rant", "x"));
  addFeedback(s, "judge", "judge could not read PDF");
  assert.match(feedbackMarkdown(s), /## judge\n- \d{4}-\d{2}-\d{2}: judge could not read PDF/);
});

// ---- queue edge cases + learning
test("queue: submitted items cannot be rejected; max 3 files", async () => {
  const s = state();
  const a = item(M1, "x 1%", "YES", "submitted");
  s.items.push(a);
  assert.throws(() => reject(s, a.id), /cannot be edited or retracted/);
  const b = item(M2, "y 2%", "YES");
  s.items.push(b);
  b.files = ["/tmp/a.png", "/tmp/b.png", "/tmp/c.pdf"];
  const extra = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fs-att-")), "d.txt");
  fs.writeFileSync(extra, "x");
  await assert.rejects(async () => await attach(s, b.id, extra), /max 3/);
});
test("learn: tags reasons and derives fallback/avoid policies", () => {
  const s = state();
  s.submissions.push(
    sub(M1, "judged", { verdict: "rejected", reason: "Could not read the linked page.", links: ["https://paywalled.example/a"] }),
    sub(M1, "judged", { verdict: "rejected", reason: "Failed to fetch the source; the page was unreadable.", links: ["https://paywalled.example/b"] }),
    sub(M1, "judged", { verdict: "irrelevant", reason: "Irrelevant to the settlement rule.", links: ["https://blog.example/a"] }),
    sub(M2, "judged", { verdict: "irrelevant", reason: "Does not relate to the question.", links: ["https://blog.example/b"] }),
    sub(M3, "judged", { verdict: "accepted", reason: "Dated official figure.", links: ["https://stats.example/r"] }),
  );
  assert.deepEqual(tagReason("Duplicate of an earlier submission"), ["duplicate"]);
  assert.equal(outcomeOf(s.submissions[4]), "accepted");
  const r = learn(s);
  assert.equal(r.newlyLearned, 5);
  assert.deepEqual(s.lessons.forceFallbackDomains, ["paywalled.example"]);
  assert.deepEqual(s.lessons.avoidDomains, ["blog.example"]);
  assert.equal(learn(s).newlyLearned, 0, "idempotent");
});

// ---- official 25 Nov 2026 rules ----
test("items: note + each link + each file count as 1, cap 3", () => {
  assert.equal(itemCount("a note", ["https://a"], ["shot.png"]), 3);
  assert.equal(itemsCheck("a note", ["https://a"], ["shot.png"]).ok, true);
  assert.equal(itemsCheck("a note", ["https://a", "https://b"], ["shot.png"]).ok, false);
  assert.match(itemsCheck("a note", ["https://a"], ["a.png", "b.pdf"]).reason!, /max 3 items/);
  assert.equal(itemCount("   ", [], []), 0);
});

test("cap: a judged duplicate verdict gives its slot back; a rejected duplicate still counts", () => {
  const s = state();
  s.submissions.push(
    sub(M1, "judged", { verdict: "accepted" }),
    sub(M1, "judged", { verdict: "duplicate" }),
    sub(M1, "rejected", { verdict: "duplicate" }),
  );
  assert.equal(countsTowardMarketCap(s.submissions[1]), false);
  assert.equal(countsTowardMarketCap(s.submissions[2]), true);
  assert.equal(usedSlots(s, M1), 2);
  assert.equal(capCheck(s, M1).remaining, 1);
});

test("tracker: a judged manipulation verdict does not count toward the prize minimum", () => {
  const s = state();
  for (let i = 0; i < 3; i++) s.submissions.push(sub(M1, "judged", { verdict: "accepted" }), sub(M2, "judged", { verdict: "irrelevant" }), sub(M3, "judged", { verdict: "accepted" }));
  s.submissions.push(sub(M3, "judged", { verdict: "manipulation" }));
  assert.equal(countsTowardQualification(s.submissions.at(-1)!), false);
  const q = qualification(s);
  assert.equal(q.judged, 9);
  assert.equal(q.qualified, false);
  assert.equal(q.needJudged, 1);
});
