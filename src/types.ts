// Shared types. MarketCard mirrors the fields the official evidence-starter reads from /markets.json;
// the real export may carry more keys, which are kept but not relied on.
export interface MarketCard {
  address: string;
  question: string;
  status: string;
  odds: { yes: number; no: number };
  evidenceCutoffAt: string;
  dataSources: string[];
  [k: string]: unknown;
}

export type Side = "YES" | "NO";
export type SourceKind = "official" | "primary" | "calendar" | "regional" | "manual" | "other";

export interface SourceRef {
  url: string;
  kind: SourceKind;
  label?: string;
}

export interface Fact {
  market: string;
  date: string; // YYYY-MM-DD the fact is true on / was published
  text: string;
  source: string;
  sourceKind: SourceKind;
  publisher: string;
  fetchedAt: string;
  relevance: number;
}

export interface SideCall {
  side: Side | null;
  confidence: "high" | "medium" | "low" | "none";
  reason: string;
}

export interface PreflightResult {
  url: string;
  checkedAt: string;
  readable: boolean;
  status?: number;
  contentType?: string;
  finalUrl?: string;
  textLength: number;
  keyTextFound: boolean | null;
  reasons: string[];
}

export type ItemStatus = "pending" | "approved" | "rejected" | "submitted";

export interface QueueItem {
  id: string;
  market: string;
  question: string;
  /** Market evidenceCutoffAt (ISO). Official: cutoff is the submission deadline, usually 24h before close. */
  cutoffAt?: string;
  fact: Fact;
  side: Side | null;
  sideCall: SideCall;
  note: string;
  links: string[];
  files: string[]; // absolute paths on disk; note + links + files <= 3 items
  preflight: PreflightResult;
  mode: "link" | "fallback";
  status: ItemStatus;
  idempotencyKey: string;
  fingerprint: string;
  createdAt: string;
  decidedAt?: string;
  rejectReason?: string;
  dryRuns: string[];
  submissionId?: string;
  lastError?: string;
  /** Hard-to-fetch source (X, Reddit, paywall, login wall): approve/submit refuse without a PNG/JPG screenshot. */
  requiresScreenshot?: boolean;
  screenshotReason?: string;
  /** Every live send attempt, all with the SAME Idempotency-Key (never regenerated). */
  attempts?: { at: string; idempotencyKey: string; outcome: string }[];
}

export interface SubmissionRecord {
  id: string;
  market: string;
  itemId: string | null; // null when imported from listSubmissions
  note: string | null;
  links: string[];
  status: string; // SDK SubmissionStatus
  verdict: string | null;
  reason: string | null;
  bounty: { amount: string; state: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface Watch {
  market: string;
  source: string;
  date: string; // upcoming release date YYYY-MM-DD
  text: string;
  addedAt: string;
}

export interface FeedbackEntry {
  at: string;
  category: string;
  text: string;
}

export interface DomainStat {
  accepted: number;
  rejected: number;
  tags: Record<string, number>;
  /** ISO time of the latest unverifiable/irrelevant verdict used for avoidDomains decay. */
  lastPenaltyAt?: string;
}

export interface Lessons {
  updatedAt: string | null;
  domains: Record<string, DomainStat>;
  tags: Record<string, number>;
  forceFallbackDomains: string[];
  avoidDomains: string[];
  processed: string[]; // submission ids already learned from
}

export interface State {
  version: 1;
  items: QueueItem[];
  sides: Record<string, Side>; // market -> locked side
  submissions: SubmissionRecord[];
  watches: Watch[];
  feedback: FeedbackEntry[];
  lessons: Lessons;
}
