import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { preflight, isBlockedHost, keyTextOnPage } from "../src/preflight.ts";

let base = "";
let server: http.Server;
const long = "<p>" + "Official release text with plenty of server-rendered words. ".repeat(20) + "</p>";
const routes: Record<string, [number, string, string]> = {
  "/ok": [200, "text/html", `<html><body>${long}<p>Inflation rose to 3.2% in October 2026.</p></body></html>`],
  "/paywall": [200, "text/html", `<html><body>${long}<p>Subscribe to continue reading.</p></body></html>`],
  "/js": [200, "text/html", `<html><body><div id=root></div><noscript>enable JavaScript</noscript><script>render()</script></body></html>`],
  "/404": [404, "text/html", "nope"],
  "/pdf": [200, "application/pdf", "%PDF-1.4"],
  "/img": [200, "image/png", "x"],
};
let fetches = 0;

before(async () => {
  server = http.createServer((req, res) => {
    fetches++;
    if (req.url === "/redirect-to-x") { res.writeHead(302, { Location: base + "/ok" }); return res.end(); }
    const r = routes[req.url ?? ""] ?? [404, "text/plain", "missing"];
    res.writeHead(r[0], { "Content-Type": r[1] });
    res.end(r[2]);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

test("preflight: readable server-rendered page with the key text passes", async () => {
  const r = await preflight(`${base}/ok`, "Inflation rose to 3.2% in October 2026");
  assert.equal(r.readable, true, r.reasons.join("; "));
  assert.equal(r.keyTextFound, true);
});
test("preflight: key text missing fails", async () => {
  const r = await preflight(`${base}/ok`, "Unemployment fell to 4.8% in Mockland");
  assert.equal(r.readable, false);
  assert.equal(r.keyTextFound, false);
});
test("preflight: paywall text fails", async () => {
  const r = await preflight(`${base}/paywall`);
  assert.equal(r.readable, false);
  assert.ok(r.reasons.some((x) => /paywall/.test(x)));
});
test("preflight: JS-only page fails", async () => {
  const r = await preflight(`${base}/js`);
  assert.equal(r.readable, false);
  assert.ok(r.reasons.some((x) => /JS-rendered|JavaScript/.test(x)));
});
test("preflight: HTTP 404 and non-readable content types fail; PDF passes", async () => {
  assert.equal((await preflight(`${base}/404`)).readable, false);
  assert.equal((await preflight(`${base}/img`)).readable, false);
  assert.equal((await preflight(`${base}/pdf`)).readable, true);
});
test("preflight: follows redirects", async () => {
  const r = await preflight(`${base}/redirect-to-x`);
  assert.equal(r.readable, true);
  assert.equal(r.finalUrl, `${base}/ok`);
});
test("preflight: X / Reddit are refused without any network call", async () => {
  const before = fetches;
  for (const u of ["https://x.com/a/status/1", "https://twitter.com/a", "https://www.reddit.com/r/x", "https://old.reddit.com/r/y"]) {
    assert.equal(isBlockedHost(u), true);
    const r = await preflight(u);
    assert.equal(r.readable, false);
  }
  assert.equal(fetches, before);
  assert.equal(isBlockedHost("https://example.com"), false);
});
test("preflight: unreachable host fails cleanly", async () => {
  const r = await preflight("http://127.0.0.1:1/nothing", undefined, { timeoutMs: 2000 });
  assert.equal(r.readable, false);
  assert.ok(r.reasons[0].startsWith("fetch error"));
});
test("keyTextOnPage: tolerant to punctuation/date format", () => {
  assert.equal(keyTextOnPage("On Nov 13, 2026, CPI rose to 3.2%!", "on 2026-11-13 cpi rose to 3.2%"), true);
});
