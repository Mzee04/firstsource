// Feedback-bounty prep (local only). Every judge rationale and every agent failure (fetch failure,
// unreadable source, API / network error, failed screenshot) is appended to data/feedback-log.jsonl.
// `feedback draft` turns that log into concise, deduplicated notes in a markdown file for a human to
// review. NOTHING here sends feedback anywhere: SDK 2.4.0 has no feedback endpoint, so the human
// sends the reviewed notes through the official form.
import fs from "node:fs";
import path from "node:path";
import type { FeedbackEntry, State } from "./types.ts";
import { hostOf } from "./text.ts";
import { tagReason, outcomeOf } from "./learn.ts";

export type LogKind = "verdict" | "fetch_failure" | "unreadable_source" | "api_error" | "network_error" | "retry" | "screenshot_failure";

export interface LogEvent {
  at: string;
  kind: LogKind;
  detail: string;
  url?: string;
  market?: string;
  itemId?: string;
  submissionId?: string;
  code?: string;
  verdict?: string | null;
  /** verdict events: accepted | rejected | unknown (from learn.outcomeOf) */
  outcome?: string;
}

export const feedbackLogPath = (dataDir: string) => path.join(dataDir, "feedback-log.jsonl");

/** Strip anything that looks like a credential before it touches disk. */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?key|token|secret|password)\s*[=:]\s*)[^\s&"']+/gi, "$1[redacted]");
}

export function logEvent(dataDir: string | undefined, e: Omit<LogEvent, "at"> & { at?: string }): void {
  if (!dataDir) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const ev: LogEvent = { ...e, at: e.at ?? new Date().toISOString(), detail: redact(String(e.detail ?? "")).slice(0, 1000) };
    fs.appendFileSync(feedbackLogPath(dataDir), JSON.stringify(ev) + "\n");
  } catch {
    /* logging must never break a run */
  }
}

export function readLog(dataDir: string): LogEvent[] {
  const p = feedbackLogPath(dataDir);
  if (!fs.existsSync(p)) return [];
  const out: LogEvent[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as LogEvent); } catch { /* skip a torn line */ }
  }
  return out;
}

/** Log the judge's verdict + rationale for every finished submission not logged yet. Returns how many were added. */
export function logVerdicts(dataDir: string, state: State, now = Date.now()): number {
  const seen = new Set(readLog(dataDir).filter((e) => e.kind === "verdict").map((e) => e.submissionId));
  let n = 0;
  for (const s of state.submissions) {
    if (seen.has(s.id)) continue;
    if (!["judged", "rejected", "failed", "unmatched"].includes(s.status)) continue;
    logEvent(dataDir, { at: new Date(now).toISOString(), kind: "verdict", detail: s.reason ?? "(no rationale given)", submissionId: s.id, market: s.market, url: s.links[0], verdict: s.verdict ?? s.status, outcome: outcomeOf(s) });
    n++;
  }
  return n;
}

/** Normalize a message so the same problem seen many times collapses into one note. */
export function normalizeDetail(d: string): string {
  return d.toLowerCase().replace(/https?:\/\/\S+/g, "<url>").replace(/\b[0-9a-f]{8,}\b/g, "<id>").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

interface Group { key: string; title: string; count: number; first: string; last: string; example: LogEvent; urls: Set<string> }

function groupKey(e: LogEvent): { key: string; title: string } {
  const host = e.url ? hostOf(e.url) : "";
  switch (e.kind) {
    case "verdict": {
      const out = e.outcome ?? "unknown";
      const tags = tagReason(e.detail);
      const t = tags.length ? tags.join("+") : "untagged";
      return { key: `verdict|${out}|${t}`, title: `Judge ${out === "unknown" ? `verdict "${e.verdict ?? "?"}"` : out} (${t})` };
    }
    case "api_error":
      return { key: `api|${e.code ?? "?"}|${normalizeDetail(e.detail)}`, title: `API error ${e.code ?? ""}`.trim() };
    default:
      return { key: `${e.kind}|${host}|${normalizeDetail(e.detail)}`, title: `${e.kind.replace("_", " ")}${host ? ` on ${host}` : ""}` };
  }
}

export function groupEvents(events: LogEvent[]): Group[] {
  const by = new Map<string, Group>();
  for (const e of events) {
    const { key, title } = groupKey(e);
    const g = by.get(key) ?? { key, title, count: 0, first: e.at, last: e.at, example: e, urls: new Set<string>() };
    g.count++;
    if (e.at < g.first) g.first = e.at;
    if (e.at > g.last) g.last = e.at;
    if (e.url) g.urls.add(e.url);
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

const SUGGEST: Record<string, (g: Group) => string> = {
  unreadable_source: (g) => `Plain fetch could not read ${hostOf(g.example.url ?? "") || "a source"}: ${g.example.detail}. Please document which hosts and content types the judge can fetch, and confirm whether a dated screenshot plus pasted text is enough for these.`,
  fetch_failure: (g) => `Fetching ${hostOf(g.example.url ?? "") || "a source"} failed: ${g.example.detail}. If the judge uses the same plain fetch, evidence from this host may be unscorable.`,
  api_error: (g) => `API returned ${g.example.code ?? "an error"}: ${g.example.detail}. ${/timeout|retry/i.test(g.example.detail) ? "" : "A clearer error message or docs entry would help agents recover."}`.trim(),
  network_error: (g) => `Network error / timeout while calling the API: ${g.example.detail}. Retries reused the same Idempotency-Key; confirming that GET /submissions shows a landed submission immediately would help.`,
  retry: (g) => `Had to retry a submission (${g.example.detail}).`,
  screenshot_failure: (g) => `Could not capture a screenshot of ${hostOf(g.example.url ?? "") || "a source"}: ${g.example.detail}.`,
};

function suggestion(g: Group): string {
  const e = g.example;
  if (e.kind === "verdict") {
    const rejected = /rejected/.test(g.title);
    return rejected
      ? `Judge rejected ${g.count} submission(s) with rationale like: "${e.detail}". ${/unreadable|untagged/.test(g.key) ? "Clarify what the judge could not do so agents can supply it." : "Useful signal; consider documenting this rule."}`
      : `Judge rationale (${g.title}): "${e.detail}".`;
  }
  return (SUGGEST[e.kind] ?? ((x: Group) => x.example.detail))(g);
}

/** Concise, deduplicated markdown for a human to review. Never sent by FirstSource. */
export function draftFeedbackMarkdown(events: LogEvent[], human: FeedbackEntry[] = [], now = Date.now()): string {
  const groups = groupEvents(events);
  const lines: string[] = [];
  lines.push("# FirstSource feedback draft (NOT SENT)");
  lines.push("");
  lines.push(`Generated ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC from ${events.length} logged event(s) and ${human.length} manual note(s).`);
  lines.push("Review and edit, then send it yourself through the official feedback form. FirstSource never sends feedback.");
  lines.push("Keep only notes that are true and useful; the bounty rewards bug reports and notes on what the agent could not do.");
  const sections: [string, (g: Group) => boolean][] = [
    ["What the judge said (verdict rationales)", (g) => g.example.kind === "verdict"],
    ["Sources the agent could not read", (g) => g.example.kind === "unreadable_source" || g.example.kind === "fetch_failure" || g.example.kind === "screenshot_failure"],
    ["API and network problems", (g) => g.example.kind === "api_error" || g.example.kind === "network_error" || g.example.kind === "retry"],
  ];
  for (const [title, pick] of sections) {
    const gs = groups.filter(pick);
    if (!gs.length) continue;
    lines.push("", `## ${title}`);
    for (const g of gs.slice(0, 15)) {
      const when = g.first.slice(0, 10) === g.last.slice(0, 10) ? g.first.slice(0, 10) : `${g.first.slice(0, 10)} to ${g.last.slice(0, 10)}`;
      const ex = g.urls.size ? ` Example: ${[...g.urls][0]}${g.urls.size > 1 ? ` (+${g.urls.size - 1} more)` : ""}` : "";
      lines.push(`- **${g.title}** (${g.count}x, ${when}): ${suggestion(g)}${ex}`);
    }
    if (gs.length > 15) lines.push(`- (${gs.length - 15} more groups in data/feedback-log.jsonl)`);
  }
  const seen = new Set<string>();
  const manual = human.filter((h) => { const k = `${h.category}|${normalizeDetail(h.text)}`; return seen.has(k) ? false : (seen.add(k), true); });
  if (manual.length) {
    lines.push("", "## Manual notes (feedback add)");
    for (const h of manual) lines.push(`- [${h.category}] ${h.text}`);
  }
  if (!groups.length && !manual.length) lines.push("", "Nothing logged yet.");
  return lines.join("\n") + "\n";
}
