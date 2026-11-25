/** The one HTTP fetch used for reading sources and for the judge preflight: plain GET, no JS, no cookies. */
import { USER_AGENT } from "./config.ts";

/** How a plainFetch failure is classified. `http` is a completed response with a non-2xx status. */
export type FetchErrorCategory = "timeout" | "dns" | "connection_refused" | "http" | "other";

export interface Fetched {
  ok: boolean;
  status: number;
  url: string;
  finalUrl: string;
  contentType: string;
  body: string;
  lastModified?: string;
  error?: string;
  errorCategory?: FetchErrorCategory;
}

/** Classify a thrown fetch/network error (not an HTTP status). */
export function categorizeFetchError(err: unknown): { category: Exclude<FetchErrorCategory, "http">; message: string } {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  const name = e?.name ?? "";
  if (name === "AbortError" || name === "TimeoutError") return { category: "timeout", message: "timeout" };
  const code = `${e?.code ?? ""} ${e?.cause?.code ?? ""}`.toLowerCase();
  const msg = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
  const blob = `${code} ${msg}`.toLowerCase();
  if (/enotfound|eai_again|enodata|err_name_not_resolved|getaddrinfo|dns error|name not resolved/.test(blob)) {
    return { category: "dns", message: (e?.message || "dns error").trim() };
  }
  if (/econnrefused|connection refused|err_connection_refused/.test(blob)) {
    return { category: "connection_refused", message: (e?.message || "connection refused").trim() };
  }
  return { category: "other", message: (e?.message || String(err)).trim() || "fetch failed" };
}

export async function plainFetch(url: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<Fetched> {
  const f = opts.fetch ?? fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  const base = { url, finalUrl: url, contentType: "", body: "" };
  try {
    const res = await f(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5" } });
    const ct = res.headers.get("content-type") ?? "";
    const isText = /text|html|json|xml/i.test(ct) || ct === "";
    const body = isText ? (await res.text()).slice(0, 2_000_000) : (await res.arrayBuffer(), "");
    const httpFail = !res.ok;
    return {
      ok: res.ok,
      status: res.status,
      url,
      finalUrl: res.url || url,
      contentType: ct,
      body,
      lastModified: res.headers.get("last-modified") ?? undefined,
      errorCategory: httpFail ? "http" : undefined,
    };
  } catch (err) {
    const { category, message } = categorizeFetchError(err);
    return { ok: false, status: 0, ...base, error: message, errorCategory: category };
  } finally {
    clearTimeout(t);
  }
}
