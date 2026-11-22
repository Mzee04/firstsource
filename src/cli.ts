#!/usr/bin/env node
// FirstSource CLI. Every command is local and safe by default; only `submit --live` (with
// FIRSTSOURCE_LIVE=1) and `accept-terms` (with FIRSTSOURCE_ACCEPT_TERMS=<version>) touch the
// account. The API key is never printed.
import fs from "node:fs";
import { describeConfig, loadConfig } from "./config.ts";
import { acquireLock, loadState, saveState } from "./store.ts";
import { loadMarkets, redraft, scan } from "./scan.ts";
import { pickMarkets } from "./picker.ts";
import { approvalWarnings, approve, attach, getItem, reject, setSide } from "./queue.ts";
import { submitItem, sync } from "./submit.ts";
import { makeClient } from "./api.ts";
import { qualification, addFeedback, feedbackMarkdown } from "./tracker.ts";
import { lessonLines, learn } from "./learn.ts";
import { preflight } from "./preflight.ts";
import type { QueueItem, Side, State } from "./types.ts";
import { lockedSide } from "./rules.ts";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));
// Commands that never read or write state.json do not take the lock.
const STATELESS = new Set(["help", "config", "preflight", "terms", "limits", "entry", "accept-terms"]);
let cfg: ReturnType<typeof loadConfig>;
let state: State;
const save = () => saveState(cfg.dataDir, state);
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);

function line(i: QueueItem): string {
  return `${i.id}  ${i.status.padEnd(9)} ${short(i.market).padEnd(14)} side=${i.side ?? "?"}(${i.sideCall.confidence}) ${i.mode.padEnd(8)} ${i.fact.date}  ${i.fact.text.slice(0, 70)}`;
}

async function main() {
  cfg = loadConfig();
  const known = new Set(["config", "markets", "scan", "list", "show", "set-side", "attach", "approve", "reject", "submit", "sync", "preflight", "status", "lessons", "feedback", "terms", "limits", "entry", "accept-terms"]);
  if (known.has(cmd) && !STATELESS.has(cmd)) {
    const release = acquireLock(cfg.dataDir);
    process.on("exit", release);
    state = loadState(cfg.dataDir);
  }
  switch (cmd) {
    case "config":
      console.log(describeConfig(cfg));
      break;
    case "markets": {
      const ms = await loadMarkets(cfg);
      const picks = pickMarkets(ms, state, { limit: 50 });
      console.log(`${ms.length} markets loaded, ${picks.length} pickable:`);
      for (const p of picks) console.log(`  ${p.score.toFixed(2)}  ${short(p.market.address)}  ${p.why}  ${p.market.question}`);
      break;
    }
    case "scan": {
      const r = await scan(state, cfg);
      save();
      console.log(`picked ${r.picks.length} market(s); queued ${r.added.length} new item(s); ${r.watchesAdded} calendar watch(es) added`);
      for (const i of r.added) console.log("  + " + line(i));
      for (const u of r.unresolvedSources) console.log(`  ! ${short(u.market)} declares sources without a URL (add the URL to config/sources.json): ${u.sources.join("; ")}`);
      if (flags.has("--verbose")) for (const s of r.skipped) console.log(`  - ${short(s.market)} ${s.why}`);
      break;
    }
    case "list": {
      const want = args[0];
      const items = state.items.filter((i) => !want || i.status === want);
      if (!items.length) console.log("(no items)");
      for (const i of items) console.log(line(i));
      break;
    }
    case "show": {
      const i = getItem(state, args[0]);
      console.log(JSON.stringify({ ...i, fact: i.fact, note: undefined }, null, 2));
      console.log("\n--- note ---\n" + i.note);
      break;
    }
    case "set-side": {
      const side = (args[1] ?? "").toUpperCase();
      if (side !== "YES" && side !== "NO") throw new Error("usage: set-side <id> YES|NO");
      const i = setSide(state, args[0], side as Side);
      redraft(i, cfg.noteMax);
      save();
      console.log(line(i));
      break;
    }
    case "attach": {
      const i = attach(state, args[0], args[1]);
      save();
      console.log(`${i.id}: ${i.files.length}/3 file(s)`);
      break;
    }
    case "approve": {
      const i = approve(state, args[0]);
      save();
      console.log("approved " + line(i));
      for (const w of approvalWarnings(i)) console.log("  warning: " + w);
      break;
    }
    case "reject": {
      const i = reject(state, args[0], args.slice(1).join(" ") || undefined);
      save();
      console.log("rejected " + line(i));
      break;
    }
    case "submit": {
      const live = flags.has("--live");
      const ids = flags.has("--all-approved") ? state.items.filter((i) => i.status === "approved").map((i) => i.id) : args;
      if (!ids.length) throw new Error("usage: submit <id>... [--live] [--no-wait] | submit --all-approved");
      const client = live ? makeClient(cfg) : undefined;
      for (const id of ids) {
        try {
          const o = await submitItem(state, cfg, id, { live, wait: !flags.has("--no-wait"), client, onSubmitted: save });
          console.log(o.mode === "dry-run" ? `DRY RUN ${o.itemId}: nothing sent. Request saved to ${o.dryRunFile}` : `LIVE ${o.itemId} -> submission ${o.submissionId}${o.alreadyLanded ? " (already landed earlier; nothing re-sent)" : ""}: ${o.status} verdict=${o.verdict ?? "-"} ${o.reason ?? ""}`);
        } catch (e) {
          console.error(`${id}: ${(e as Error).message}`);
          process.exitCode = 1;
        } finally {
          save();
        }
      }
      break;
    }
    case "sync": {
      const r = await sync(state, makeClient(cfg));
      save();
      console.log(`synced: ${r.fetched} fetched, ${r.imported} imported, ${r.updated} updated`);
      break;
    }
    case "preflight": {
      const r = await preflight(args[0], args.slice(1).join(" ") || undefined);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "status": {
      const q = qualification(state);
      console.log(`Qualification: ${q.judged}/10 judged across ${q.judgedMarkets}/3 markets -> ${q.qualified ? "QUALIFIED" : `need ${q.needJudged} more judged, ${q.needMarkets} more market(s)`}; ${q.pending} still judging`);
      for (const p of q.perMarket) console.log(`  ${short(p.market)}  submitted ${p.submitted}, judged ${p.judged}, accepted ${p.accepted}, reserved ${p.reserved}, slots left ${p.slotsLeft}  side=${lockedSide(state, p.market) ?? "-"}`);
      const counts = state.items.reduce<Record<string, number>>((a, i) => ((a[i.status] = (a[i.status] ?? 0) + 1), a), {});
      console.log(`Queue: ${JSON.stringify(counts)}`);
      const upcoming = state.watches.filter((w) => w.date >= new Date().toISOString().slice(0, 10)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
      if (upcoming.length) console.log("Next official releases:\n" + upcoming.map((w) => `  ${w.date} ${short(w.market)} ${w.text.slice(0, 80)}`).join("\n"));
      break;
    }
    case "lessons":
      learn(state);
      save();
      for (const l of lessonLines(state)) console.log("- " + l);
      break;
    case "feedback": {
      const sub = args[0];
      if (sub === "add") { const e = addFeedback(state, args[1], args.slice(2).join(" ")); save(); console.log(`logged ${e.category}: ${e.text}`); }
      else if (sub === "export") { const f = `${cfg.dataDir}/feedback.md`; fs.writeFileSync(f, feedbackMarkdown(state)); console.log(`wrote ${f} (draft only, nothing posted)`); }
      else for (const f of state.feedback) console.log(`${f.at.slice(0, 10)} [${f.category}] ${f.text}`);
      break;
    }
    case "terms": {
      const { data } = await makeClient(cfg).getTerms();
      console.log(`terms version ${data.version}; accepted: ${data.acceptedAt ?? "NO"}; read: ${data.url}`);
      break;
    }
    case "limits": {
      const { data } = await makeClient(cfg).getLimits();
      console.log(data);
      break;
    }
    case "entry": {
      const { data } = await makeClient(cfg).getEntryState(args[0]);
      console.log(data);
      break;
    }
    case "accept-terms": {
      // Human-only step. Runs only when the operator sets FIRSTSOURCE_ACCEPT_TERMS to the exact current version.
      const client = makeClient(cfg);
      const { data: t } = await client.getTerms();
      if (t.acceptedAt) { console.log(`already accepted ${t.version} at ${t.acceptedAt}`); break; }
      if (process.env.FIRSTSOURCE_ACCEPT_TERMS !== t.version) { console.log(`Not accepting. Read ${t.url}, then (only if you agree) run with FIRSTSOURCE_ACCEPT_TERMS=${t.version}`); break; }
      const { data } = await client.acceptTerms(t.version);
      console.log(`accepted terms ${data.version} at ${data.acceptedAt}`);
      break;
    }
    default:
      console.log(`FirstSource — Delphi evidence agent (local; dry-run by default)

  config                      show config (key shown only as set/unset)
  markets                     list pickable markets (uncertain, open, slots left)
  scan [--verbose]            read sources, extract dated facts, queue drafts as pending
  list [status]               list queue (pending|approved|rejected|submitted)
  show <id>                   full item + drafted note
  set-side <id> YES|NO        set/override the side (one side per market is enforced)
  attach <id> <file>          add a screenshot/PDF (max 3 files)
  approve <id> | reject <id> [reason]
  submit <id>... [--all-approved]   DRY RUN: writes the exact request to data/dryruns, sends nothing
  submit <id> --live [--no-wait]    real submit; also needs FIRSTSOURCE_LIVE=1
  sync                        pull our submissions + verdicts (listSubmissions)
  status                      qualification tracker (10 judged / 3 markets), slots, watches
  lessons                     what past verdicts taught us
  preflight <url> [key text]  check whether a plain fetch (like the judge) can read a page
  feedback add <cat> <text> | feedback list | feedback export
  terms | limits | entry <market>   read-only API calls
  accept-terms                human-only; needs FIRSTSOURCE_ACCEPT_TERMS=<version>`);
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
