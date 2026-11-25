import { createHash } from "node:crypto";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};

export const DATE_PATTERNS: { re: RegExp; to: (m: RegExpExecArray) => string | null }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, to: (m) => iso(+m[1], +m[2], +m[3]) },
  { re: new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"), to: (m) => iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]) },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}\\.?,?\\s+(\\d{4})\\b`, "gi"), to: (m) => iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]) },
];

/** All dates found in a string, as YYYY-MM-DD, in order of appearance. */
export function findDates(s: string): string[] {
  const hits: { at: number; d: string }[] = [];
  for (const { re, to } of DATE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const d = to(m);
      if (d) hits.push({ at: m.index, d });
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.d);
}

/** Replace any date in the text with its ISO form, so "Nov 16, 2026" and "2026-11-16" fingerprint the same. */
export function normalizeDates(s: string): string {
  let out = s;
  for (const { re, to } of DATE_PATTERNS) out = out.replace(new RegExp(re.source, re.flags), (...a) => {
    const m = a.slice(0, -2) as unknown as RegExpExecArray;
    return to(m) ?? a[0];
  });
  return out;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** HTML -> readable text, the way a no-JS fetch sees it (scripts and styles dropped). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|br|table|ul|ol)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function sentences(text: string): string[] {
  return text
    .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|No|Mr|Ms|Dr|St)\./g, "$1")
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z"“])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 600);
}

export const STOP = new Set(
  "a an the of to in on at by for from with and or is are was were be been will would should could than that this these those it its as into over under before after during between about above below up down out not no yes what which who whom whose when where why how do does did has have had more most less least any all each per vs via if then so such there their they them our your we you i he she his her".split(" "),
);

export function tokens(s: string): string[] {
  return normalizeDates(s.toLowerCase())
    .replace(/[^a-z0-9.%\- ]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((t) => t && !STOP.has(t));
}

export function keywords(question: string): string[] {
  return [...new Set(tokens(question).filter((t) => t.length >= 3 && !/^\d/.test(t)))];
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Deterministic UUID-shaped key from a seed, so a retry of the same item reuses the same Idempotency-Key. */
export function uuidFromSeed(seed: string): string {
  const h = sha256(`firstsource:${seed}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());
export const todayUtc = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);


/** Turn "October 2026" / "Oct. 2026" into "2026-10" so month-year is a stable identity token. */
export function normalizeMonthYears(s: string): string {
  const mon = new RegExp("\\b" + MON + "\\.?\\s+(\\d{4})\\b", "gi");
  return s.replace(mon, (all, m, y) => {
    const n = MONTHS[String(m).toLowerCase()];
    return n ? `${y}-${String(n).padStart(2, "0")}` : all;
  });
}

/** Comma-grouped figures become plain digits ("165,000" -> "165000") so comparisons are stable. */
export function normalizeFigures(s: string): string {
  return s.replace(/[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?/g, (m) => m.replace(/,/g, ""));
}

/**
 * Canonical numeric figures in `s`, after dates are normalized to ISO and skipped so
 * "Nov 13, 2026" and "2026-11-13" do not yield bare 11/13/2026 parts.
 * Values are decimal-normalized ("3.20" -> "3.2").
 */
export function extractFigures(s: string): string[] {
  const t = normalizeFigures(normalizeMonthYears(normalizeDates(s)));
  const skip: [number, number][] = [];
  for (const m of t.matchAll(/\b\d{4}-\d{2}(?:-\d{2})?\b/g)) skip.push([m.index!, m.index! + m[0].length]);
  const out: string[] = [];
  const re = /[+-]?\d+(?:\.\d+)?%?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (skip.some(([a, b]) => m!.index >= a && m!.index < b)) continue;
    const core = m[0].replace(/^\+/, "").replace(/%$/, "");
    const n = Number(core);
    if (Number.isFinite(n)) out.push(String(n));
  }
  return out;
}
