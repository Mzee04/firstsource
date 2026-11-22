import path from "node:path";

// Env var NAMES only. Values come from the environment on day one; nothing is hard-coded.
export const ENV = {
  site: "COMPETITION_SITE_URL", // competition site; /markets.json is read from it
  apiUrl: "DELPHI_API_URL", // evidence API base incl. /v1
  apiKey: "DELPHI_API_ACCESS_KEY", // DELPHI_API_KEY is read as a fallback (same as the starter)
  apiKeyLegacy: "DELPHI_API_KEY",
  agentId: "AGENT_ID",
  agentModel: "AGENT_MODEL",
  live: "FIRSTSOURCE_LIVE", // must be "1" for any real submit
  acceptTerms: "FIRSTSOURCE_ACCEPT_TERMS", // must equal the terms version for accept-terms to run
  dataDir: "FIRSTSOURCE_DATA_DIR",
  sources: "FIRSTSOURCE_SOURCES", // path to sources config (calendars + regional)
  noteMax: "FIRSTSOURCE_NOTE_MAX",
  perMarket: "FIRSTSOURCE_PER_MARKET",
  marketsFile: "FIRSTSOURCE_MARKETS_FILE", // optional local markets.json instead of the site
} as const;

export interface Config {
  siteUrl?: string;
  apiUrl?: string;
  apiKey?: string;
  agentId: string;
  agentModel?: string;
  live: boolean;
  dataDir: string;
  sourcesFile: string;
  noteMax: number;
  perMarket: number;
  marketsFile?: string;
}

/** Positive integer from env, else the default. Rejects junk loudly instead of letting NaN disable a cap. */
export function intEnv(raw: string | undefined, def: number, name: string, min = 1, max = 100_000): number {
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

/** SDK: X-Agent-* headers must be 1 to 64 printable ASCII characters. */
export function headerValue(raw: string | undefined, def: string | undefined, name: string): string | undefined {
  const v = raw === undefined || raw === "" ? def : raw;
  if (v === undefined) return undefined;
  if (!/^[\x20-\x7e]{1,64}$/.test(v)) throw new Error(`${name} must be 1 to 64 printable ASCII characters`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    siteUrl: env[ENV.site] || undefined,
    apiUrl: env[ENV.apiUrl] || undefined,
    apiKey: env[ENV.apiKey] || env[ENV.apiKeyLegacy] || undefined,
    agentId: headerValue(env[ENV.agentId], "firstsource", ENV.agentId)!,
    // The contest asks agents to send ID, harness and model. FirstSource uses no LLM.
    agentModel: headerValue(env[ENV.agentModel], "rule-based (no LLM)", ENV.agentModel),
    live: env[ENV.live] === "1",
    dataDir: path.resolve(env[ENV.dataDir] || "data"),
    sourcesFile: path.resolve(env[ENV.sources] || "config/sources.json"),
    noteMax: intEnv(env[ENV.noteMax], 1200, ENV.noteMax, 200, 20_000),
    perMarket: intEnv(env[ENV.perMarket], 2, ENV.perMarket, 1, 3),
    marketsFile: env[ENV.marketsFile] || undefined,
  };
}

/** Safe to print: never includes the key, only whether one is set. */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    siteUrl: c.siteUrl ?? "(unset)",
    apiUrl: c.apiUrl ?? "(unset)",
    apiKey: c.apiKey ? "(set)" : "(unset)",
    agentId: c.agentId,
    agentModel: c.agentModel ?? "(unset)",
    noteMax: c.noteMax,
    perMarket: c.perMarket,
    live: c.live,
    dataDir: c.dataDir,
    sourcesFile: c.sourcesFile,
    marketsFile: c.marketsFile ?? "(unset)",
  };
}

export const USER_AGENT = "FirstSource/0.1 (+evidence preflight; plain fetch, no JS)";
