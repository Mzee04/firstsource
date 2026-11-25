/** Learn from verdict rationales. Tags each judged reason, keeps per-domain accept/reject
 * counts, and derives two policies the scanner applies: force the pasted-text fallback for domains
 * the judge could not read, and skip domains that only ever got rejected for unverifiable/irrelevant
 * reasons. Official dataSources of a market are never avoided. Avoid-list entries decay.
 *
 * Official verdicts (evidence-api.md): accepted, duplicate, unverifiable, irrelevant,
 * no information, manipulation. Keyword fallback kept for older/odd values.
 */
import type { Lessons, State, SubmissionRecord } from "./types.ts";
import { hostOf } from "./text.ts";

/** How long an avoidDomains entry lasts after the last unverifiable/irrelevant penalty. */
export const AVOID_DOMAIN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const REASON_TAGS: [string, RegExp][] = [
  ["duplicate", /duplicat|already (submitted|known|reported)|not new|seen before/i],
  // Tight unreadable signals only. Loose words like "login", "blocked", or "404" (URLs, "access blocked") are not enough.
  ["unreadable", /could not (read|fetch|load|access|open)|unreadable|not accessible|failed to (load|fetch)|paywall|login wall|sign-?in wall|empty page/i],
  ["undated", /no date|undated|not dated|missing date|unclear date/i],
  ["irrelevant", /irrelevant|not relevant|unrelated|does not (bear|relate)|off[- ]topic/i],
  ["stale", /stale|outdated|too old|after (the )?cutoff|before (the )?market|already priced/i],
  ["weak_source", /unofficial|unreliable|weak source|not (a )?primary|secondary source|opinion|speculat/i],
  ["opposite", /opposite|contradict|cancel/i],
  ["unsupported", /not supported|does not support|cannot verify|unverifiable|not in (the )?source/i],
];

export function tagReason(reason: string | null): string[] {
  if (!reason) return [];
  return REASON_TAGS.filter(([, re]) => re.test(reason)).map(([t]) => t);
}

function verdictNorm(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
}

export function outcomeOf(s: SubmissionRecord): "accepted" | "rejected" | "unknown" {
  if (s.status === "rejected" || s.status === "failed" || s.status === "unmatched") return "rejected";
  if (s.status !== "judged") return "unknown";
  const v = verdictNorm(s.verdict);
  if (v === "accepted") return "accepted";
  if (["duplicate", "unverifiable", "irrelevant", "no information", "manipulation"].includes(v)) return "rejected";
  if (/\bnot[ -]?accepted\b|\bnon-?accepted\b/.test(v)) return "rejected";
  if (/reject|invalid|duplicate|irrelevant|fail|no_?value|deny|denied|unverifiable|manipulation/.test(v)) return "rejected";
  // Must not treat "not accepted" as accepted (handled above). Lookbehind guards other "not …" forms.
  if (/(?<!\bnot )(?<!\bnon )(?<!\bno )\b(accepted|valid|approved|useful|pass|credited|counted)\b/.test(v)) return "accepted";
  if (s.bounty && Number(s.bounty.amount) > 0) return "accepted";
  return "unknown";
}

/** Failed, unmatched, and judged-duplicate outcomes do not count as domain penalties. */
export function skipDomainPenalty(s: SubmissionRecord): boolean {
  if (s.status === "failed" || s.status === "unmatched") return true;
  return s.status === "judged" && verdictNorm(s.verdict) === "duplicate";
}

export interface LearnOpts {
  now?: number;
  /** Hosts that must never appear in avoidDomains (typically markets' declared dataSources). */
  protectedHosts?: Iterable<string>;
}

export function learn(state: State, opts: LearnOpts = {}): { newlyLearned: number; lessons: Lessons } {
  const L = state.lessons;
  const now = opts.now ?? Date.now();
  const protect = new Set<string>();
  for (const h of opts.protectedHosts ?? []) {
    const x = String(h).replace(/^www\./, "").toLowerCase().trim();
    if (x) protect.add(x);
  }
  let n = 0;
  for (const s of state.submissions) {
    if (L.processed.includes(s.id)) continue;
    const out = outcomeOf(s);
    if (out === "unknown") continue;
    const domains = [...new Set(s.links.map(hostOf).filter(Boolean))];
    const tags = tagReason(s.reason);
    const v = verdictNorm(s.verdict);
    if (v === "unverifiable" && !tags.includes("unverifiable")) tags.push("unverifiable");
    if (v === "irrelevant" && !tags.includes("irrelevant")) tags.push("irrelevant");
    const skipPen = skipDomainPenalty(s);
    const isPenalty = tags.includes("unverifiable") || tags.includes("unsupported") || tags.includes("irrelevant");
    for (const d of domains.length ? domains : ["(no link)"]) {
      const st = (L.domains[d] ??= { accepted: 0, rejected: 0, tags: {} });
      if (out === "accepted") st.accepted++;
      else if (!skipPen) {
        st.rejected++;
        if (isPenalty) st.lastPenaltyAt = s.updatedAt || s.createdAt || new Date(now).toISOString();
      }
      if (!skipPen) {
        for (const t of tags) st.tags[t] = (st.tags[t] ?? 0) + 1;
      }
    }
    for (const t of tags) L.tags[t] = (L.tags[t] ?? 0) + 1;
    L.processed.push(s.id);
    n++;
  }
  L.forceFallbackDomains = Object.entries(L.domains)
    .filter(([, st]) => (st.tags.unreadable ?? 0) >= 2)
    .map(([d]) => d);
  L.avoidDomains = Object.entries(L.domains)
    .filter(([d, st]) => {
      if (protect.has(d)) return false;
      if (st.accepted > 0) return false;
      const penalties = (st.tags.unverifiable ?? 0) + (st.tags.unsupported ?? 0) + (st.tags.irrelevant ?? 0);
      if (penalties < 2) return false;
      if (!st.lastPenaltyAt) return false;
      const at = Date.parse(st.lastPenaltyAt);
      return Number.isFinite(at) && now - at <= AVOID_DOMAIN_TTL_MS;
    })
    .map(([d]) => d);
  L.updatedAt = new Date(now).toISOString();
  return { newlyLearned: n, lessons: L };
}

/**
 * True when the scanner should skip this URL because of avoidDomains.
 * A market's declared dataSources are never skipped.
 */
export function isAvoidedSource(state: State, url: string, dataSources: readonly string[] = []): boolean {
  const h = hostOf(url);
  if (!h || !state.lessons.avoidDomains.includes(h)) return false;
  if (dataSources.some((d) => hostOf(d) === h)) return false;
  return true;
}

/** Rank boost for a source domain from past verdicts (0.5 .. 1.5). */
export function domainWeight(state: State, url: string): number {
  const st = state.lessons.domains[hostOf(url)];
  if (!st) return 1;
  return 0.5 + (st.accepted + 1) / (st.accepted + st.rejected + 2);
}

export function lessonLines(state: State): string[] {
  const L = state.lessons;
  const out: string[] = [];
  const acc = Object.values(L.domains).reduce((a, d) => a + d.accepted, 0);
  const rej = Object.values(L.domains).reduce((a, d) => a + d.rejected, 0);
  if (acc + rej) {
    const best = Object.entries(L.domains).sort((a, b) => b[1].accepted - a[1].accepted).slice(0, 3).map(([d, st]) => `${d} (${st.accepted}/${st.accepted + st.rejected})`);
    out.push(`Judged so far: ${acc} accepted, ${rej} rejected. Best sources: ${best.join(", ")}`);
  }
  const tags = Object.entries(L.tags).sort((a, b) => b[1] - a[1]);
  if (tags.length) out.push(`Rejection reasons seen: ${tags.map(([t, c]) => `${t} x${c}`).join(", ")}`);
  if (L.forceFallbackDomains.length) out.push(`Always attach pasted text + capture for: ${L.forceFallbackDomains.join(", ")}`);
  if (L.avoidDomains.length) out.push(`Skipping (repeated unverifiable/irrelevant, never accepted; decays after 14 days): ${L.avoidDomains.join(", ")}`);
  if ((L.tags.duplicate ?? 0) > 0) out.push("Duplicates happened: prefer the newest official release, submit early after it drops.");
  if ((L.tags.undated ?? 0) > 0) out.push("Undated rejections: lead every note with 'As of YYYY-MM-DD'.");
  if (!out.length) out.push("No judged verdicts yet.");
  return out;
}
