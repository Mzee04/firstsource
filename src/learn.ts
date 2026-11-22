// Part 11: learn from verdict rationales. Tags each judged reason, keeps per-domain accept/reject
// counts, and derives two policies the scanner applies: force the pasted-text fallback for domains
// the judge could not read, and skip domains that only ever got rejected.
// ASSUMPTION: the verdict vocabulary is not published yet; we classify by keywords and bounty.
import type { Lessons, State, SubmissionRecord } from "./types.ts";
import { hostOf } from "./text.ts";

export const REASON_TAGS: [string, RegExp][] = [
  ["duplicate", /duplicat|already (submitted|known|reported)|not new|seen before/i],
  ["unreadable", /could not (read|fetch|load|access|open)|unreadable|not accessible|failed to (load|fetch)|paywall|login|blocked|404|empty page/i],
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

export function outcomeOf(s: SubmissionRecord): "accepted" | "rejected" | "unknown" {
  if (s.status === "rejected" || s.status === "failed" || s.status === "unmatched") return "rejected";
  if (s.status !== "judged") return "unknown";
  const v = (s.verdict ?? "").toLowerCase();
  if (/reject|invalid|duplicate|irrelevant|fail|no_?value|deny|denied/.test(v)) return "rejected";
  if (/accept|valid|approved|useful|pass|credited|counted/.test(v)) return "accepted";
  if (s.bounty && Number(s.bounty.amount) > 0) return "accepted";
  return "unknown";
}

export function learn(state: State): { newlyLearned: number; lessons: Lessons } {
  const L = state.lessons;
  let n = 0;
  for (const s of state.submissions) {
    if (L.processed.includes(s.id)) continue;
    const out = outcomeOf(s);
    if (out === "unknown") continue;
    const domains = [...new Set(s.links.map(hostOf).filter(Boolean))];
    const tags = tagReason(s.reason);
    for (const d of domains.length ? domains : ["(no link)"]) {
      const st = (L.domains[d] ??= { accepted: 0, rejected: 0, tags: {} });
      st[out]++;
      for (const t of tags) st.tags[t] = (st.tags[t] ?? 0) + 1;
    }
    for (const t of tags) L.tags[t] = (L.tags[t] ?? 0) + 1;
    L.processed.push(s.id);
    n++;
  }
  L.forceFallbackDomains = Object.entries(L.domains).filter(([, st]) => (st.tags.unreadable ?? 0) >= 1).map(([d]) => d);
  L.avoidDomains = Object.entries(L.domains).filter(([, st]) => st.rejected >= 2 && st.accepted === 0).map(([d]) => d);
  L.updatedAt = new Date().toISOString();
  return { newlyLearned: n, lessons: L };
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
  if (L.avoidDomains.length) out.push(`Skipping (rejected >=2, never accepted): ${L.avoidDomains.join(", ")}`);
  if ((L.tags.duplicate ?? 0) > 0) out.push("Duplicates happened: prefer the newest official release, submit early after it drops.");
  if ((L.tags.undated ?? 0) > 0) out.push("Undated rejections: lead every note with 'As of YYYY-MM-DD'.");
  if (!out.length) out.push("No judged verdicts yet.");
  return out;
}
