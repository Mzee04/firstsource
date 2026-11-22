// Hard-to-fetch sources: hosts the judge's basic fetch usually cannot read (X/Twitter, Reddit,
// paywalls, login walls). Evidence from them must carry the key quoted text in the note AND a dated
// screenshot (URL + date visible). The list is: built-in defaults + `hardToFetch` in the sources
// config + FIRSTSOURCE_HARD_HOSTS (comma separated).
import type { PreflightResult, QueueItem } from "./types.ts";
import { BLOCKED_HOSTS } from "./preflight.ts";
import { hostOf } from "./text.ts";
import path from "node:path";

/** Common paywalled / login-gated news hosts (fetchable, but usually only a teaser). */
export const PAYWALL_HOSTS = ["ft.com", "wsj.com", "bloomberg.com", "nytimes.com", "economist.com", "barrons.com", "theinformation.com", "washingtonpost.com", "thetimes.co.uk", "telegraph.co.uk", "seekingalpha.com", "theathletic.com", "nikkei.com", "asia.nikkei.com", "businessinsider.com", "politico.com"];
export const DEFAULT_HARD_HOSTS = [...new Set([...BLOCKED_HOSTS, ...PAYWALL_HOSTS])];

export function hardHostList(...extra: (string[] | undefined)[]): string[] {
  const all = [...DEFAULT_HARD_HOSTS];
  for (const list of extra) for (const h of list ?? []) { const v = h.trim().toLowerCase().replace(/^www\./, ""); if (v) all.push(v); }
  return [...new Set(all)];
}

export function isHardHost(url: string, hosts: string[] = DEFAULT_HARD_HOSTS): boolean {
  const h = hostOf(url);
  return !!h && hosts.some((b) => h === b || h.endsWith(`.${b}`));
}

const WALL = /paywall|sign-in wall|login|bot check|captcha|redirected to/i;

/** Why this evidence needs a dated screenshot, or null if it does not. */
export function screenshotReason(url: string, pf: PreflightResult | undefined, hosts: string[] = DEFAULT_HARD_HOSTS): string | null {
  if (isHardHost(url, hosts)) return `${hostOf(url)} is a hard-to-fetch host (the judge's basic fetch usually fails on it)`;
  const wall = pf?.reasons.find((r) => WALL.test(r));
  if (wall) return `preflight: ${wall}`;
  return null;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);
export const hasImage = (files: string[]) => files.some((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));

/** Blocking check used by approve and submit: a hard-source item must carry a screenshot. */
export function screenshotCheck(it: QueueItem): { ok: boolean; reason?: string } {
  if (!it.requiresScreenshot) return { ok: true };
  if (hasImage(it.files)) return { ok: true };
  return { ok: false, reason: `needs a dated screenshot (PNG/JPG showing the URL and date) because ${it.screenshotReason ?? "the source is hard to fetch"}; run: attach ${it.id} shot.png` };
}
