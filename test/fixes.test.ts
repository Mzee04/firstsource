import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { item, state, sub } from "./helpers.ts";
import { keyTextOnPage } from "../src/preflight.ts";
import { pageDate, extractFacts } from "../src/extract.ts";
import { nearDuplicate, figureKey } from "../src/novelty.ts";
import { learn, outcomeOf, tagReason, isAvoidedSource, AVOID_DOMAIN_TTL_MS } from "../src/learn.ts";
import { categorizeFetchError, plainFetch } from "../src/fetcher.ts";
import { pdfPageCount as countPages, filesCheck as checkFiles, sideCompatible } from "../src/rules.ts";
import { approve, setSide } from "../src/queue.ts";
import { assertSubmitFlags } from "../src/submit.ts";
import { textPdf as makePdf } from "../src/pdf.ts";
import type { MarketCard } from "../src/types.ts";

const M1 = "0xMarket1";

// ---- keyTextOnPage figures ----
test("keyTextOnPage: figures in the key text must appear on the page", () => {
  const page = "The official release says inflation rose and the labour market was mixed in October 2026.";
  assert.equal(keyTextOnPage(page, "inflation rose to 3.2% in October 2026"), false);
  assert.equal(keyTextOnPage("On Nov 13, 2026, CPI rose to 3.2%!", "on 2026-11-13 cpi rose to 3.2%"), true);
  assert.equal(keyTextOnPage("Payrolls increased by 165,000 in October 2026.", "payrolls increased by 165000 in October 2026"), true);
  assert.equal(keyTextOnPage("Payrolls increased by 48,000 in October 2026.", "payrolls increased by 165,000 in October 2026"), false);
});

// ---- Last-Modified is not a fact date ----
test("pageDate: HTTP Last-Modified is not used as the fact date", () => {
  const f = {
    ok: true, status: 200, url: "https://s.example/r", finalUrl: "https://s.example/r",
    contentType: "text/html", body: "<html><body><p>No publication date here, only a number 3.</p></body></html>",
    lastModified: "Wed, 01 Jan 2020 00:00:00 GMT",
  };
  assert.equal(pageDate(f), null);
  const m: MarketCard = { address: "0x1", question: "Will the Statistics Office report CPI inflation above 3.0%?", status: "open", odds: { yes: 0.5, no: 0.5 }, evidenceCutoffAt: "2026-12-20T00:00:00Z", dataSources: [] };
  const ex = extractFacts(m, { url: f.url, kind: "official" }, f, Date.parse("2026-11-20T00:00:00Z"));
  assert.equal(ex.facts.length, 0);
});

// ---- novelty paraphrases ----
test("dedup: paraphrases with the same figures are caught; a new figure or month is not", () => {
  const a = "Nonfarm payroll employment rose by 165,000 in October 2026, the BLS reported";
  const b = "The BLS reported that nonfarm payrolls increased 165000 in October 2026";
  assert.equal(nearDuplicate(a, b), true);
  assert.equal(figureKey(a), figureKey(b));
  assert.equal(nearDuplicate(a, "Nonfarm payroll employment rose by 48,000 in October 2026, the BLS reported"), false);
  assert.equal(nearDuplicate("CPI was 3.1% in September 2026", "CPI was 3.1% in October 2026"), false);
});

// ---- outcomeOf / learn policies ----
test("outcomeOf: 'not accepted' is not treated as accepted", () => {
  const s = sub(M1, "judged", { verdict: "not accepted" });
  assert.equal(outcomeOf(s), "rejected");
  assert.equal(outcomeOf(sub(M1, "judged", { verdict: "accepted" })), "accepted");
});

test("learn: one unreadable verdict does not force fallback; loose words are not unreadable", () => {
  assert.deepEqual(tagReason("Please login to continue"), []);
  assert.ok(!tagReason("HTTP 404 on the article").includes("unreadable"));
  assert.ok(!tagReason("request blocked by the CDN").includes("unreadable"));
  assert.ok(tagReason("Could not read the linked page.").includes("unreadable"));
  const s = state();
  s.submissions.push(sub(M1, "judged", { verdict: "rejected", reason: "Could not read the linked page.", links: ["https://paywalled.example/a"] }));
  learn(s);
  assert.deepEqual(s.lessons.forceFallbackDomains, []);
});

test("learn: failed, unmatched and judged-duplicate do not create avoidDomains", () => {
  const s = state();
  s.submissions.push(
    sub(M1, "failed", { reason: "Irrelevant to the settlement rule.", links: ["https://blog.example/a"] }),
    sub(M1, "unmatched", { reason: "Irrelevant to the settlement rule.", links: ["https://blog.example/b"] }),
    sub(M1, "judged", { verdict: "duplicate", reason: "Duplicate of an earlier submission", links: ["https://blog.example/c"] }),
    sub(M1, "judged", { verdict: "duplicate", reason: "Duplicate of an earlier submission", links: ["https://blog.example/d"] }),
  );
  learn(s);
  assert.deepEqual(s.lessons.avoidDomains, []);
  assert.equal(s.lessons.domains["blog.example"]?.rejected ?? 0, 0);
});

test("learn: avoidDomains decays after 14 days and never includes protected official hosts", () => {
  const now = Date.parse("2026-11-25T19:00:00Z");
  const old = new Date(now - AVOID_DOMAIN_TTL_MS - 86400000).toISOString();
  const recent = new Date(now - 86400000).toISOString();
  const s = state();
  s.submissions.push(
    sub(M1, "judged", { verdict: "irrelevant", reason: "Irrelevant to the settlement rule.", links: ["https://stale.example/a"], updatedAt: old, createdAt: old }),
    sub(M1, "judged", { verdict: "unverifiable", reason: "Cannot verify the figure.", links: ["https://stale.example/b"], updatedAt: old, createdAt: old }),
    sub(M1, "judged", { verdict: "irrelevant", reason: "Irrelevant to the settlement rule.", links: ["https://fresh.example/a"], updatedAt: recent, createdAt: recent }),
    sub(M1, "judged", { verdict: "unverifiable", reason: "Cannot verify the figure.", links: ["https://fresh.example/b"], updatedAt: recent, createdAt: recent }),
    sub(M1, "judged", { verdict: "irrelevant", reason: "Irrelevant to the settlement rule.", links: ["https://www.bls.gov/x"], updatedAt: recent, createdAt: recent }),
    sub(M1, "judged", { verdict: "unverifiable", reason: "Cannot verify the figure.", links: ["https://www.bls.gov/y"], updatedAt: recent, createdAt: recent }),
  );
  learn(s, { now, protectedHosts: ["bls.gov"] });
  assert.ok(s.lessons.avoidDomains.includes("fresh.example"));
  assert.ok(!s.lessons.avoidDomains.includes("stale.example"), "expired entry must drop");
  assert.ok(!s.lessons.avoidDomains.includes("bls.gov"), "official host is protected");
  assert.equal(isAvoidedSource(s, "https://www.bls.gov/news.release/empsit.nr0.htm", ["https://www.bls.gov/news.release/empsit.nr0.htm"]), false);
  assert.equal(isAvoidedSource(s, "https://fresh.example/a"), true);
  // decay on a later learn() without new submissions
  const later = learn(s, { now: now + AVOID_DOMAIN_TTL_MS + 86400000, protectedHosts: ["bls.gov"] });
  assert.equal(later.newlyLearned, 0);
  assert.deepEqual(s.lessons.avoidDomains, []);
});

// ---- shared side-lock helper ----
test("sideCompatible: shared helper blocks the opposite side; setSide uses it", async () => {
  const s = state();
  const a = item(M1, "Inflation rose to 3.2% in October.", "YES");
  const b = item(M1, "Core inflation fell to 2.1% in October.", "NO");
  s.items.push(a, b);
  await approve(s, a.id);
  const c = sideCompatible(s, M1, "NO");
  assert.equal(c.ok, false);
  assert.match(c.reason ?? "", /argues NO, market locked to YES/);
  assert.equal(sideCompatible(s, M1, "YES").ok, true);
  assert.equal(sideCompatible(s, M1, null).ok, true);
  assert.throws(() => setSide(s, b.id, "NO"), /locked to YES/);
});

// ---- submit flags ----
test("submit: --all-approved cannot be combined with --live", () => {
  assert.throws(() => assertSubmitFlags({ live: true, allApproved: true }), /--all-approved cannot be combined with --live/);
  assertSubmitFlags({ live: true, allApproved: false });
  assertSubmitFlags({ live: false, allApproved: true });
});

// ---- fetch error categories ----
test("categorizeFetchError: timeout, dns, connection_refused, other", () => {
  assert.equal(categorizeFetchError(Object.assign(new Error("aborted"), { name: "AbortError" })).category, "timeout");
  assert.equal(categorizeFetchError(Object.assign(new Error("getaddrinfo ENOTFOUND example.invalid"), { code: "ENOTFOUND" })).category, "dns");
  assert.equal(categorizeFetchError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" })).category, "connection_refused");
  assert.equal(categorizeFetchError(new Error("socket hang up")).category, "other");
});

test("plainFetch: HTTP non-2xx is category http; refused port is connection_refused or other", async () => {
  const httpFail = await plainFetch("https://example.invalid/", {
    fetch: (async () => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } })) as typeof fetch,
  });
  assert.equal(httpFail.ok, false);
  assert.equal(httpFail.status, 404);
  assert.equal(httpFail.errorCategory, "http");
  const refused = await plainFetch("http://127.0.0.1:1/none", { timeoutMs: 500 });
  assert.equal(refused.ok, false);
  assert.ok(refused.errorCategory === "connection_refused" || refused.errorCategory === "timeout" || refused.errorCategory === "other", refused.errorCategory);
});

// ---- pdf-lib page count ----
test("pdfPageCount: pdf-lib counts pages; filesCheck rejects more than 20", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-pdf-"));
  const one = path.join(dir, "one.pdf");
  fs.writeFileSync(one, makePdf("Title", "Body of the capture."));
  assert.equal(await countPages(one), 1);
  assert.equal((await checkFiles([one])).ok, true);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 21; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`page ${i + 1}`, { x: 50, y: 800, size: 12, font });
  }
  const many = path.join(dir, "many.pdf");
  fs.writeFileSync(many, await doc.save());
  assert.equal(await countPages(many), 21);
  const fc = await checkFiles([many]);
  assert.equal(fc.ok, false);
  assert.match(fc.reason ?? "", /21 PDF pages/);
});
