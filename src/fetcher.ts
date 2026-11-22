// The one HTTP fetch used for reading sources and for the judge preflight: plain GET, no JS, no cookies.
import { USER_AGENT } from "./config.ts";

export interface Fetched {
  ok: boolean;
  status: number;
  url: string;
  finalUrl: string;
  contentType: string;
  body: string;
  lastModified?: string;
  error?: string;
}

export async function plainFetch(url: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<Fetched> {
  const f = opts.fetch ?? fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await f(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5" } });
    const ct = res.headers.get("content-type") ?? "";
    const isText = /text|html|json|xml/i.test(ct) || ct === "";
    const body = isText ? (await res.text()).slice(0, 2_000_000) : (await res.arrayBuffer(), "");
    return { ok: res.ok, status: res.status, url, finalUrl: res.url || url, contentType: ct, body, lastModified: res.headers.get("last-modified") ?? undefined };
  } catch (e) {
    return { ok: false, status: 0, url, finalUrl: url, contentType: "", body: "", error: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}
