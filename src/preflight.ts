// Part 7: judge-fetch preflight. The judge reads links with a basic fetch (no browser, no search),
// so we do the same: plain GET, no JS. A link is "readable" only if it returns 2xx, a readable
// content type, enough server-rendered text, no paywall/JS wall, and (when given) the key text.
import type { PreflightResult } from "./types.ts";
import { plainFetch } from "./fetcher.ts";
import { decodeEntities, hostOf, htmlToText, tokens } from "./text.ts";

/** Hosts the judge is known to fail on (login walls / JS apps). Checked without fetching. */
export const BLOCKED_HOSTS = ["x.com", "twitter.com", "mobile.twitter.com", "reddit.com", "old.reddit.com", "t.me", "facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "discord.com", "discord.gg", "threads.net"];

const PAYWALL = /(subscribe to (continue|read)|subscribers? only|subscriber-only|to continue reading|create a free account to (continue|read)|sign in to (continue|read)|this content is for (members|subscribers)|paywall|you have reached your (free )?article limit)/i;
const JSWALL = /(enable javascript|requires javascript|javascript is (disabled|required)|please turn on javascript|you need to enable javascript)/i;
const BOTWALL = /(verify you are human|are you a robot|captcha|access denied|attention required)/i;

export const MIN_TEXT = 400;

export function isBlockedHost(url: string): boolean {
  const h = hostOf(url);
  return BLOCKED_HOSTS.some((b) => h === b || h.endsWith(`.${b}`));
}

/** True when the key text appears verbatim (normalized) or >=70% of its content tokens are on the page. */
export function keyTextOnPage(pageText: string, key: string): boolean {
  const norm = (s: string) => tokens(s).join(" ");
  const p = norm(pageText), k = norm(key);
  if (!k) return false;
  if (p.includes(k)) return true;
  const kt = [...new Set(tokens(key))];
  const pt = new Set(tokens(pageText));
  return kt.filter((t) => pt.has(t)).length / kt.length >= 0.7;
}

export async function preflight(url: string, keyText?: string, opts: { fetch?: typeof fetch; timeoutMs?: number; now?: number } = {}): Promise<PreflightResult> {
  const checkedAt = new Date(opts.now ?? Date.now()).toISOString();
  const base = { url, checkedAt, textLength: 0, keyTextFound: null as boolean | null };
  if (isBlockedHost(url)) return { ...base, readable: false, reasons: [`host ${hostOf(url)} is not readable by a plain fetch (login/JS wall)`] };
  const f = await plainFetch(url, opts);
  const reasons: string[] = [];
  if (f.error) reasons.push(`fetch error: ${f.error}`);
  if (f.status && (f.status < 200 || f.status >= 300)) reasons.push(`HTTP ${f.status}`);
  if (f.finalUrl && isBlockedHost(f.finalUrl)) reasons.push(`redirected to ${hostOf(f.finalUrl)}`);
  const isPdf = /application\/pdf/i.test(f.contentType);
  const readableType = isPdf || /text\/html|text\/plain|application\/xhtml|application\/json|text\/xml|application\/xml|application\/(rss|atom)\+xml/i.test(f.contentType);
  if (f.status && !readableType) reasons.push(`content-type "${f.contentType || "none"}" not readable`);
  let text = "";
  if (!isPdf && readableType && !f.error) {
    text = /html|xml/i.test(f.contentType) ? htmlToText(f.body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => decodeEntities(c))) : f.body;
    if (text.length < MIN_TEXT) reasons.push(`only ${text.length} chars of server-rendered text (JS-rendered page?)`);
    if (JSWALL.test(text) && text.length < 3000) reasons.push("page asks for JavaScript");
    if (PAYWALL.test(text)) reasons.push("paywall / sign-in wall text found");
    if (BOTWALL.test(text) && text.length < 3000) reasons.push("bot check / captcha page");
  }
  let keyTextFound: boolean | null = null;
  if (keyText && !isPdf && text) {
    keyTextFound = keyTextOnPage(text, keyText);
    if (!keyTextFound) reasons.push("key text not found in the plain-fetch text");
  }
  // PDFs: the judge can read PDFs; we accept them on status + type, but do not parse them here.
  return { url, checkedAt, readable: reasons.length === 0, status: f.status, contentType: f.contentType, finalUrl: f.finalUrl, textLength: text.length, keyTextFound, reasons };
}
