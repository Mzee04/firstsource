// Mock of (a) the competition site's /markets.json, (b) the source pages markets point at, and
// (c) the Delphi evidence API, following the paths, bodies and error envelope used by
// @gensyn-ai/gensyn-delphi-sdk 2.4.0 (src: dist/client/evidence.js). The judge here is a toy.
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const MOCK_KEY = "mock-key-not-a-secret";
const H = (s: string) => createHash("sha256").update(s).digest("hex");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.% ]+/g, " ").replace(/\s+/g, " ").trim();

const filler = `<p>This page is published for the public record. Figures are seasonally adjusted unless noted and may be revised in later releases. Methodology notes, revision policy and contact details for the press office are available on the methodology page. All times are given in UTC.</p>`;

function pages(base: string): Record<string, { type: string; body: string; status?: number }> {
  const html = (site: string, date: string, body: string) => `<!doctype html><html><head><meta property="og:site_name" content="${site}"><meta property="article:published_time" content="${date}T09:00:00Z"><title>${site}</title></head><body><article>${body}${filler}${filler}</article></body></html>`;
  return {
    "/src/stats/cpi-release": { type: "text/html; charset=utf-8", body: html("Mock Statistics Office", "2026-11-13", `<h1>Consumer Price Index, October 2026</h1><p>Consumer price inflation rose to 3.2% in October 2026, the Statistics Office reported on 2026-11-13.</p><p>Food prices were the largest upward contributor this month.</p><p>The next CPI inflation release from the Statistics Office is scheduled for December 11, 2026.</p>`) },
    "/src/stats/calendar": { type: "text/html; charset=utf-8", body: html("Mock Statistics Office", "2026-10-01", `<h1>Release calendar</h1><ul><li>CPI inflation release (November 2026 data) from the Statistics Office: December 11, 2026</li><li>Labour market report: December 4, 2026</li></ul>`) },
    "/src/labour/release": { type: "text/html; charset=utf-8", body: html("Mock Labour Bureau", "2026-11-06", `<h1>Labour market, October 2026</h1><p>The national unemployment rate in Mockland fell to 4.8% in October 2026, the Labour Bureau said on November 6, 2026.</p>`) },
    "/src/northport/news": { type: "text/html; charset=utf-8", body: html("Northport Courier", "2026-11-18", `<h1>Council backs transit levy</h1><p>Northport City Council approved the transit levy in a 7-2 vote on November 18, 2026, according to the council minutes.</p><p>The Northport transit levy still needs a second council reading scheduled for December 2, 2026.</p>`) },
    "/src/cb/statement": { type: "text/html; charset=utf-8", body: html("Central Bank of Mockland", "2026-11-05", `<h1>Monetary policy statement</h1><p>At its meeting on November 5, 2026 the Central Bank of Mockland held its policy rate unchanged at 4.25%.</p>`) },
    "/src/cb/dashboard": { type: "text/html; charset=utf-8", body: `<!doctype html><html><head><title>Dashboard</title></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script src="/app.js"></script></body></html>` },
    "/src/news/orion-paywalled": { type: "text/html; charset=utf-8", body: html("Space Ledger", "2026-11-17", `<h1>Orion readies Vega-2</h1><p>Orion Aerospace confirmed on November 17, 2026 that its Vega-2 rocket completed its final static fire test, with launch scheduled for December 19, 2026.</p><div class="paywall">Subscribe to continue reading. Subscribers only.</div>`) },
    "/src/gone": { type: "text/html", body: "not found", status: 404 },
    "/src/report.pdf": { type: "application/pdf", body: "%PDF-1.4 mock" },
  };
}

function markets(base: string, now: number) {
  const day = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString();
  return {
    markets: [
      { address: "0xA1000000000000000000000000000000000000c1", question: "Will the Statistics Office report November 2026 CPI inflation above 3.0%?", status: "open", odds: { yes: 0.55, no: 0.45 }, evidenceCutoffAt: iso(now + 20 * day), dataSources: [`${base}/src/stats/cpi-release`] },
      { address: "0xA2000000000000000000000000000000000000c2", question: "Will Northport City Council approve the transit levy before 2026-12-10?", status: "open", odds: { yes: 0.62, no: 0.38 }, evidenceCutoffAt: iso(now + 15 * day), dataSources: ["Northport City Clerk minutes"] },
      { address: "0xA3000000000000000000000000000000000000c3", question: "Will the Central Bank of Mockland cut its policy rate at the December 2026 meeting?", status: "open", odds: { yes: 0.4, no: 0.6 }, evidenceCutoffAt: iso(now + 12 * day), dataSources: [`${base}/src/cb/statement`, `${base}/src/cb/dashboard`] },
      { address: "0xA4000000000000000000000000000000000000c4", question: "Will Orion Aerospace launch its Vega-2 rocket before 2026-12-31?", status: "open", odds: { yes: 0.5, no: 0.5 }, evidenceCutoffAt: iso(now + 30 * day), dataSources: [`${base}/src/news/orion-paywalled`, "https://x.com/orion_example/status/1"] },
      { address: "0xA5000000000000000000000000000000000000c5", question: "Will the Mockland national unemployment rate for October 2026 be below 5.0%?", status: "open", odds: { yes: 45, no: 55 }, evidenceCutoffAt: iso(now + 8 * day), dataSources: [`${base}/src/labour/release`] },
      { address: "0xA6000000000000000000000000000000000000c6", question: "Will the bridge reopen by 2026-11-01?", status: "resolved", odds: { yes: 0.5, no: 0.5 }, evidenceCutoffAt: iso(now - 20 * day), dataSources: [] },
      { address: "0xA7000000000000000000000000000000000000c7", question: "Will the city win the bid?", status: "open", odds: { yes: 0.97, no: 0.03 }, evidenceCutoffAt: iso(now + 9 * day), dataSources: [] },
      { address: "0xA8000000000000000000000000000000000000c8", question: "Will the mayor resign before 2026-11-19?", status: "open", odds: { yes: 0.5, no: 0.5 }, evidenceCutoffAt: iso(now - day), dataSources: [] },
    ],
  };
}

interface MockSub {
  id: string; createdAt: string; agentId: string | null; note: string; links: string[]; files: { name: string | null; contentType: string; sizeBytes: number }[];
  status: string; market: string; polls: number; verdict: string | null; reason: string | null; bodyHash: string;
}

export interface Mock {
  url: string;
  apiUrl: string;
  close: () => Promise<void>;
  stats: { submitCalls: number; acceptCalls: number; requests: string[]; idempotencyKeys: string[]; agentHeaders: Record<string, string>[] };
  subs: MockSub[];
  /**
   * Fault injection for POST /submissions (each counter is decremented when used):
   *  - dropAfterLanding: save the submission, then kill the connection (client sees a network error)
   *  - hangAfterLanding: save the submission, then never answer in time (client times out)
   *  - dropBeforeLanding: kill the connection before saving anything
   *  - listLagOnce: the next GET /submissions does not show the newest submission yet
   */
  faults: { dropAfterLanding: number; hangAfterLanding: number; dropBeforeLanding: number; listLag: number; hangMs: number };
  terms: { version: string; url: string; acceptedAt: string | null };
}

export async function startMock(port = 0): Promise<Mock> {
  const stats = { submitCalls: 0, acceptCalls: 0, requests: [] as string[], idempotencyKeys: [] as string[], agentHeaders: [] as Record<string, string>[] };
  const faults = { dropAfterLanding: 0, hangAfterLanding: 0, dropBeforeLanding: 0, listLag: 0, hangMs: 1500 };
  const subs: MockSub[] = [];
  const idem = new Map<string, MockSub>();
  let base = "";
  const terms = { version: "2026-11-25", url: "", acceptedAt: null as string | null };
  const startedAt = Date.now();

  const judge = (s: MockSub) => {
    const earlier = subs.filter((x) => x !== s && x.status === "judged" && x.verdict === "accepted");
    const ft = norm(s.note.split("\n")[0].replace(/^as of \S+ /i, ""));
    if (!/as of \d{4}-\d{2}-\d{2}/i.test(s.note)) return ["rejected", "The note has no dated fact."];
    if (earlier.some((x) => norm(x.note.split("\n")[0].replace(/^as of \S+ /i, "")) === ft && x.market === s.market)) return ["rejected", "Duplicate of an earlier accepted submission on this market."];
    if (s.links.some((l) => /x\.com|reddit\.com/.test(l)) && s.files.length === 0) return ["rejected", "Could not read the linked page."];
    if (s.links.some((l) => l.includes("orion-paywalled")) && s.files.length === 0) return ["rejected", "Could not read the linked page (paywall)."];
    return ["accepted", "Dated fact from the source, relevant to the settlement rule."];
  };

  const view = (s: MockSub) => ({
    id: s.id, createdAt: s.createdAt, agentId: s.agentId, note: s.note, links: s.links, files: s.files, status: s.status,
    ...(s.status === "queued" || s.status === "judging" ? { judgingEstimateSeconds: 1 } : {}),
    markets: [{ marketAddress: s.market, status: s.status === "judged" ? "judged" : "pending", verdict: s.verdict, reason: s.reason, bounty: s.verdict === "accepted" ? { amount: "250000", state: "held" } : s.verdict ? { amount: "0", state: "none" } : null, settlementUpTo: null }],
  });

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "X-Request-Id": randomUUID(), "X-Contract-Version": "mock-1", ...headers });
    res.end(JSON.stringify(body));
  };
  const err = (res: http.ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}) => send(res, status, { error: { code, message, retryable: false, ...extra } });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", base);
    stats.requests.push(`${req.method} ${u.pathname}`);
    if (u.pathname === "/markets.json") return send(res, 200, markets(base, startedAt));
    const pg = pages(base)[u.pathname];
    if (pg) { res.writeHead(pg.status ?? 200, { "Content-Type": pg.type }); return res.end(pg.body); }
    if (!u.pathname.startsWith("/v1/")) { res.writeHead(404); return res.end("not found"); }
    if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) return err(res, 401, "unauthorized", "bad key");
    const p = u.pathname.slice(3);
    const allMarkets = markets(base, startedAt).markets;

    if (req.method === "GET" && p === "/terms") return send(res, 200, terms);
    if (req.method === "POST" && p === "/terms/acceptance") {
      stats.acceptCalls++;
      let raw = ""; for await (const c of req) raw += c;
      const v = JSON.parse(raw || "{}").termsVersion;
      if (v !== terms.version) return err(res, 400, "invalid_request", "not the current terms version", { field: "termsVersion" });
      terms.acceptedAt ??= new Date().toISOString();
      return send(res, 200, { version: terms.version, acceptedAt: terms.acceptedAt });
    }
    if (req.method === "GET" && p === "/limits") return send(res, 200, { submitsPerHour: 20, submissionsPerMarket: 3, submitsLeftThisHour: 20, hourEndsAt: new Date(Date.now() + 3.6e6).toISOString(), dailyCapLeft: "50000000", dailyCapResetAt: new Date(Date.now() + 8.64e7).toISOString() });
    let m = /^\/markets\/([^/]+)\/entry-state$/.exec(p);
    if (req.method === "GET" && m) {
      const addr = decodeURIComponent(m[1]).toLowerCase();
      const mk = allMarkets.find((x) => x.address.toLowerCase() === addr);
      if (!mk) return err(res, 404, "market_not_found", "unknown market");
      const used = subs.filter((s) => s.market.toLowerCase() === addr).length;
      const open = mk.status === "open" && Date.parse(mk.evidenceCutoffAt) > Date.now();
      return send(res, 200, { canSubmit: open && used < 3 && !!terms.acceptedAt, ...(open ? used >= 3 ? { reason: "cap_reached" } : terms.acceptedAt ? {} : { reason: "terms_not_accepted" } : { reason: "market_closed" }), remainingOnMarket: Math.max(0, 3 - used), judgementPotRemainingBaseUnits: "100000000", rateLimit: { resetAt: new Date(Date.now() + 3.6e6).toISOString() } });
    }
    if (req.method === "POST" && p === "/submissions") {
      stats.submitCalls++;
      if (!terms.acceptedAt) return err(res, 403, "terms_not_accepted", "accept the terms first", { terms: { version: terms.version, url: terms.url } });
      const key = String(req.headers["idempotency-key"] ?? "");
      stats.idempotencyKeys.push(key);
      stats.agentHeaders.push({ id: String(req.headers["x-agent-id"] ?? ""), harness: String(req.headers["x-agent-harness"] ?? ""), model: String(req.headers["x-agent-model"] ?? "") });
      if (!key) return err(res, 400, "invalid_request", "Idempotency-Key required", { field: "Idempotency-Key" });
      if (faults.dropBeforeLanding > 0) { faults.dropBeforeLanding--; req.socket.destroy(); return; }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks);
      const form = await new Request(base + "/x", { method: "POST", headers: { "content-type": String(req.headers["content-type"]) }, body: raw }).formData();
      const note = String(form.get("note") ?? "");
      const links = form.getAll("links[]").map(String);
      const files = form.getAll("files").filter((f): f is File => typeof f !== "string").map((f) => ({ name: f.name || null, contentType: f.type, sizeBytes: f.size }));
      const market = String(form.get("marketAddress") ?? "");
      const bodyHash = H(JSON.stringify({ note, links, market, files }));
      const prior = idem.get(key);
      if (prior) return prior.bodyHash === bodyHash ? send(res, 200, view(prior), { "Retry-After": "1" }) : err(res, 409, "idempotency_conflict", "same key, different body");
      if (files.length > 3) return err(res, 400, "invalid_request", "max 3 files", { field: "files" });
      const items = (note.trim() ? 1 : 0) + links.length + files.length;
      if (items > 3) return err(res, 400, "invalid_request", "max 3 items (note, each link and each file)", { field: items - (note.trim() ? 1 : 0) - links.length > 3 ? "files" : "links[]" });
      if (!note.trim()) return err(res, 400, "invalid_request", "note required", { field: "note" });
      const mk = allMarkets.find((x) => x.address.toLowerCase() === market.toLowerCase());
      if (!mk) return err(res, 404, "market_not_found", "unknown market", { field: "marketAddress" });
      if (subs.filter((s) => s.market.toLowerCase() === market.toLowerCase()).length >= 3) return err(res, 429, "cap_reached", "3 submissions per market");
      const s: MockSub = { id: `sub_${subs.length + 1}`, createdAt: new Date().toISOString(), agentId: String(req.headers["x-agent-id"] ?? "") || null, note, links, files, status: "queued", market: mk.address, polls: 0, verdict: null, reason: null, bodyHash };
      subs.push(s); idem.set(key, s);
      if (faults.dropAfterLanding > 0) { faults.dropAfterLanding--; req.socket.destroy(); return; }
      if (faults.hangAfterLanding > 0) { faults.hangAfterLanding--; setTimeout(() => { try { if (!res.writableEnded && !req.socket.destroyed) send(res, 202, view(s)); } catch { /* client gone */ } }, faults.hangMs); return; }
      return send(res, 202, view(s), { "Retry-After": "1", Location: `/v1/submissions/${s.id}` });
    }
    m = /^\/submissions\/([^/]+)$/.exec(p);
    if (req.method === "GET" && m) {
      const s = subs.find((x) => x.id === decodeURIComponent(m![1]));
      if (!s) return err(res, 404, "not_found", "no such submission");
      s.polls++;
      if (s.status === "queued") s.status = "judging";
      else if (s.status === "judging") { const [v, r] = judge(s); s.status = "judged"; s.verdict = v; s.reason = r; }
      return send(res, 200, view(s), s.status === "judged" ? {} : { "Retry-After": "1" });
    }
    if (req.method === "GET" && p === "/submissions") {
      const limit = Math.min(Number(u.searchParams.get("limit") ?? 20), 100);
      const start = Number(u.searchParams.get("cursor") ?? 0);
      let list = subs.filter((s) => !u.searchParams.get("market") || s.market.toLowerCase() === u.searchParams.get("market")!.toLowerCase());
      if (faults.listLag > 0) { faults.listLag--; list = list.slice(0, -1); }
      const items = list.slice(start, start + limit).map(view);
      return send(res, 200, { items, nextCursor: start + limit < list.length ? String(start + limit) : null });
    }
    return err(res, 404, "not_found", "no route");
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  terms.url = `${base}/terms.html`;
  return { url: base, apiUrl: `${base}/v1`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }), stats, subs, terms, faults };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = await startMock(Number(process.env.MOCK_PORT || 8787));
  console.log(`mock up at ${m.url}\n  export COMPETITION_SITE_URL=${m.url}\n  export DELPHI_API_URL=${m.apiUrl}\n  export DELPHI_API_ACCESS_KEY=${MOCK_KEY}   # mock-only placeholder\n  export FIRSTSOURCE_SOURCES=config/sources.mock.json`);
}
