import { test } from "node:test";
import assert from "node:assert/strict";
import { findDates, htmlToText, uuidFromSeed } from "../src/text.ts";
import { inferSide } from "../src/side.ts";
import { extractFacts } from "../src/extract.ts";
import { draftNote } from "../src/drafter.ts";
import { detectPlaces, planSources } from "../src/sources.ts";

test("dates: ISO, US and day-first forms", () => {
  assert.deepEqual(findDates("on 2026-11-13, Nov. 5, 2026 and 18 November 2026"), ["2026-11-13", "2026-11-05", "2026-11-18"]);
  assert.deepEqual(findDates("Feb 30, 2026"), []);
});
test("side: threshold questions compare the figure", () => {
  assert.equal(inferSide("Will CPI be above 3.0%?", "CPI rose to 3.2% on 2026-11-13").side, "YES");
  assert.equal(inferSide("Will CPI be above 3.0%?", "CPI eased to 2.8% in October 2026").side, "NO");
  assert.equal(inferSide("Will unemployment be below 5.0%?", "Unemployment fell to 4.8% on November 6, 2026").side, "YES");
  assert.equal(inferSide("Will CPI be above 3.0%?", "CPI was 3.2% after 2.9% a month earlier").side, null);
});
test("side: event questions use outcome words, unclear -> null", () => {
  assert.equal(inferSide("Will the council approve the levy?", "The council approved the levy 7-2.").side, "YES");
  assert.equal(inferSide("Will the launch happen?", "The launch was postponed to 2027.").side, "NO");
  assert.equal(inferSide("Will X happen?", "People talked about X.").side, null);
});
test("idempotency key is stable per item and UUID-shaped", () => {
  assert.equal(uuidFromSeed("abc"), uuidFromSeed("abc"));
  assert.notEqual(uuidFromSeed("abc"), uuidFromSeed("abd"));
  assert.match(uuidFromSeed("abc"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test("extract: dated facts kept, future items become watches, undated dropped", () => {
  const m = { address: "0x1", question: "Will the Statistics Office report CPI inflation above 3.0%?", status: "open", odds: { yes: 0.5, no: 0.5 }, evidenceCutoffAt: "2026-12-20T00:00:00Z", dataSources: [] };
  const body = `<html><head><title>T</title></head><body><p>Consumer price inflation rose to 3.2% in October, the Statistics Office reported on 2026-11-13.</p><p>The next CPI inflation release from the Statistics Office is scheduled for December 11, 2026.</p><p>Statistics Office CPI inflation commentary has 3 parts.</p></body></html>`;
  const ex = extractFacts(m, { url: "https://s.example/r", kind: "official" }, { ok: true, status: 200, url: "https://s.example/r", finalUrl: "https://s.example/r", contentType: "text/html", body }, Date.parse("2026-11-20T00:00:00Z"));
  assert.equal(ex.facts.length, 1);
  assert.equal(ex.facts[0].date, "2026-11-13");
  assert.equal(ex.watches.length, 1);
  assert.equal(ex.watches[0].date, "2026-12-11");
});
test("html: scripts and head are not treated as page text", () => {
  assert.equal(htmlToText("<html><head><title>X</title></head><body><script>var a=1</script><p>Hi there</p></body></html>"), "Hi there");
});
test("drafter: note is dated, sourced, sided, and capped", () => {
  const fact = { market: "0x1", date: "2026-11-13", text: "CPI rose to 3.2%. ".repeat(100), source: "https://s.example/r", sourceKind: "official" as const, publisher: "S", fetchedAt: "", relevance: 1 };
  const n = draftNote({ question: "Q?", fact, side: "YES", preflight: { url: "", checkedAt: "2026-11-20T10:00:00Z", readable: false, textLength: 0, keyTextFound: null, reasons: [] }, max: 600 });
  assert.ok(n.length <= 600);
  assert.match(n, /^As of 2026-11-13: /);
  assert.match(n, /Key text/);
});
test("sources: declared URLs used, named sources reported, places detected from config", () => {
  const cfg = { calendars: [{ match: "CPI", url: "https://cal.example" }], regional: [{ place: "Northport", urls: ["https://np.example"] }], official: [] };
  assert.deepEqual(detectPlaces("Will Northport City Council approve it?", cfg), ["Northport"]);
  const p = planSources({ address: "0x", question: "Will Northport CPI rise?", status: "open", odds: { yes: 0.5, no: 0.5 }, evidenceCutoffAt: "", dataSources: ["https://off.example", "City Clerk"] }, cfg);
  assert.deepEqual(p.sources.map((s) => s.kind), ["official", "calendar", "regional"]);
  assert.deepEqual(p.unresolved, ["City Clerk"]);
});
