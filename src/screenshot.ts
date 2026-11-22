// Dated screenshot capture for hard-to-fetch sources (X, Reddit, paywalls, login walls).
// The FAQ: the judge fetches each link once with a basic fetch, so for these sources the note must
// carry the key text AND a screenshot showing the URL and the date. This uses a locally installed
// headless Chrome/Chromium (no npm dependency). If none is found, the human attaches one with
// `attach <id> shot.png` (or `add-manual ... --screenshot shot.png`).
//
// Output: one PNG with a banner on top ("URL: ...", "Captured: YYYY-MM-DD HH:MM UTC") above the
// rendered page, so the URL and date are visible in the image itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const CANDIDATES = [
  "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

function onPath(bin: string): string | null {
  if (bin.includes("/")) return fs.existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

/** FIRSTSOURCE_CHROME wins; else the first Chrome/Chromium found. null = no headless browser available. */
export function findChrome(explicit?: string): string | null {
  if (explicit) return onPath(explicit);
  for (const c of CANDIDATES) { const p = onPath(c); if (p) return p; }
  return null;
}

/**
 * Minimal Chrome DevTools Protocol session over Node's built-in WebSocket. Chrome's one-shot
 * `--screenshot` flag can hang on managed machines (force-installed extensions), so the page is
 * driven over CDP instead: navigate, wait for load, Page.captureScreenshot.
 */
class Cdp {
  private id = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private waiters: { method: string; res: () => void }[] = [];
  private constructor(private ws: WebSocket) {
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id && this.pending.has(d.id)) {
        const p = this.pending.get(d.id)!;
        this.pending.delete(d.id);
        d.error ? p.rej(new Error(`${d.error.message ?? "CDP error"}`)) : p.res(d.result);
      } else if (d.method) {
        this.waiters = this.waiters.filter((w) => (w.method === d.method ? (w.res(), false) : true));
      }
    };
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("CDP websocket failed")); });
    return new Cdp(ws);
  }
  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  waitFor(method: string, ms: number): Promise<boolean> {
    return new Promise((res) => {
      const t = setTimeout(() => res(false), ms);
      this.waiters.push({ method, res: () => { clearTimeout(t); res(true); } });
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function launch(chrome: string, args: string[], timeoutMs: number): Promise<{ proc: ChildProcess; port: string }> {
  const proc = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  let buf = "";
  const port = await new Promise<string>((res, rej) => {
    const t = setTimeout(() => rej(new Error("browser did not start (no DevTools endpoint)")), timeoutMs);
    proc.stderr!.on("data", (d) => { buf += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buf); if (m) { clearTimeout(t); res(m[1]); } });
    proc.on("error", (e) => { clearTimeout(t); rej(e); });
    proc.on("exit", (c) => { clearTimeout(t); rej(new Error(`browser exited (${c})`)); });
  });
  return { proc, port };
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const isPng = (f: string) => fs.existsSync(f) && fs.statSync(f).size > 100 && fs.readFileSync(f).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

export interface ScreenshotResult { ok: boolean; file?: string; capturedAt: string; error?: string }

export async function captureScreenshot(url: string, outFile: string, opts: { chrome?: string | null; now?: number; timeoutMs?: number; width?: number; height?: number } = {}): Promise<ScreenshotResult> {
  const capturedAt = new Date(opts.now ?? Date.now()).toISOString();
  const chrome = opts.chrome === undefined ? findChrome() : opts.chrome;
  if (!chrome) return { ok: false, capturedAt, error: "no headless Chrome/Chromium found (set FIRSTSOURCE_CHROME or attach a screenshot by hand)" };
  if (!/^https?:\/\//i.test(url)) return { ok: false, capturedAt, error: "only http(s) URLs can be captured" };
  const w = opts.width ?? 1280, h = opts.height ?? 1400, banner = 88;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-shot-"));
  // A throwaway profile: never touches (or locks) any signed-in browser profile on this machine.
  const base = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(tmp, "profile")}`];
  if (typeof process.getuid === "function" && process.getuid() === 0) base.push("--no-sandbox");
  const timeout = opts.timeoutMs ?? 45_000;
  let proc: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    const l = await launch(chrome, [...base, "--remote-debugging-port=0", `--window-size=${w},${h}`, "about:blank"], 20_000);
    proc = l.proc;
    const target = await (await fetch(`http://127.0.0.1:${l.port}/json/new?about:blank`, { method: "PUT" })).json() as { webSocketDebuggerUrl: string };
    cdp = await Cdp.open(target.webSocketDebuggerUrl);
    const deadline = Date.now() + timeout;
    const left = () => Math.max(1000, deadline - Date.now());
    await cdp.call("Page.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.waitFor("Page.loadEventFired", Math.min(20_000, left()));
    const nav = await cdp.call<{ errorText?: string }>("Page.navigate", { url });
    if (nav.errorText) return { ok: false, capturedAt, error: `navigation failed: ${nav.errorText}` };
    await loaded;
    await new Promise((r) => setTimeout(r, 2500)); // let client-side rendering settle
    const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    const stamp = `${capturedAt.slice(0, 16).replace("T", " ")} UTC`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#fff;font-family:Arial,Helvetica,sans-serif}
      .b{box-sizing:border-box;height:${banner}px;padding:10px 16px;background:#111;color:#fff;border-bottom:4px solid #f5a623}
      .u{font-size:17px;word-break:break-all;line-height:22px;max-height:44px;overflow:hidden}
      .d{font-size:16px;color:#f5d38a;margin-top:6px}
      img{display:block;width:${w}px;height:${h}px}
    </style></head><body><div class="b"><div class="u">URL: ${escHtml(url)}</div><div class="d">Captured: ${stamp} (FirstSource screenshot for Delphi evidence)</div></div>
    <img src="data:image/png;base64,${shot.data}"></body></html>`;
    const blank = cdp.waitFor("Page.loadEventFired", 10_000);
    await cdp.call("Page.navigate", { url: "about:blank" });
    await blank;
    const tree = await cdp.call<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    await cdp.call("Page.setDocumentContent", { frameId: tree.frameTree.frame.id, html });
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: w, height: h + banner, deviceScaleFactor: 1, mobile: false });
    await cdp.call("Runtime.evaluate", { expression: "Promise.all([...document.images].map(i => i.decode().catch(() => null)))", awaitPromise: true });
    const framed = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h + banner, scale: 1 } });
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(outFile), Buffer.from(framed.data, "base64"));
    if (!isPng(outFile)) return { ok: false, capturedAt, error: "could not compose the dated screenshot" };
    return { ok: true, file: path.resolve(outFile), capturedAt };
  } catch (e) {
    return { ok: false, capturedAt, error: (e as Error).message.split("\n")[0].slice(0, 300) };
  } finally {
    cdp?.close();
    if (proc && proc.exitCode === null) { proc.kill("SIGKILL"); await new Promise((r) => setTimeout(r, 300)); }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
