# FirstSource

FirstSource is an evidence-mining agent for the **Delphi Agent Arena: Evidence Mining** contest (Gensyn), listed at https://dorahacks.io/hackathon/2479/detail.

It finds **dated facts from each market's own settlement sources** before they spread elsewhere. It checks that the judge can actually read each link, and it puts every draft in front of a human before anything is sent.

It is built on `@gensyn-ai/gensyn-delphi-sdk@2.4.0` (`EvidenceClient`). The API calls follow the SDK's code in `dist/client/evidence.js` and the official `examples/evidence-starter`.

> Status: built and tested locally against a mock of the API only. The real API, key, `/markets.json`
> and agent guide are released when submissions open on **25 Nov 2026, 17:00 UTC**. See "Untested until the real API" below.

## Safety defaults
- **Dry run by default.** `submit` writes the exact request to `data/dryruns/` and sends nothing.
- **A live submit needs all of the following:** `FIRSTSOURCE_LIVE=1`, the `--live` flag, an item a human `approve`d, terms already accepted on the account, `EntryState.canSubmit`, a free slot on the market (at most 3), the market's locked side, and a fact that isn't a duplicate.
- **The terms are never accepted automatically.** `accept-terms` runs only when the operator sets `FIRSTSOURCE_ACCEPT_TERMS` to the exact current version.
- **The key is never printed.** `config` shows only `(set)` or `(unset)`.
- **Every submit is idempotent.** The `Idempotency-Key` is derived from the item id, so retrying after a network error can't create a second submission.
- **Fresh account check before every live send.** The live path pulls this account's submissions on that market (`listSubmissions({ market })`, as the SDK 2.4.0 README advises). A send that already landed on an earlier attempt (for example a timeout after the server saved it) is matched by note and marked submitted. Nothing is re-sent, and the same fact sent from another run or machine is blocked as a duplicate.
- **The evidence cutoff is the deadline.** The FAQ says the cutoff is the submission deadline, so `approve` and `submit` refuse once a market's cutoff has passed.
- **One run at a time.** Commands that touch `data/state.json` take a lock file (`data/.lock`), so two runs can't overwrite each other's changes. A lock left by a crashed run is reclaimed. Each save also keeps the previous copy as `state.json.bak`.
- **Every API call has a 60 s timeout.** The SDK sets none. A timed-out submit is safe to retry because the key is the same.
- **Submissions are final.** They can't be rejected or edited once sent, which matches the contest rule of no edits and no retractions.

## The 12 parts
| # | Part | File |
|---|---|---|
| 1 | Market picker. It keeps markets that are open, before their cutoff, and in the 20–80% odds band, then ranks them by uncertainty, time left, and slots left, spreading picks over at least 3 markets. | `src/picker.ts` |
| 2 | Official sources and calendars. It reads the declared `dataSources` URLs and the release calendars from `config/sources.json`. Future dates become **watches**. | `src/sources.ts`, `src/extract.ts` |
| 3 | Local and regional sources. When a question names a place (found through config aliases or a built-in list of places), it adds that place's sources from config. | `src/sources.ts` |
| 4 | Dated-fact extraction. It keeps sentences that are relevant, contain a figure or an outcome word, and carry a date. It drops undated sentences and anything after the cutoff. | `src/extract.ts` |
| 5 | Novelty filter. It compares fingerprints (with dates normalised to ISO) and near-duplicates against queued items, local submissions, and `listSubmissions` notes. | `src/novelty.ts` |
| 6 | One side per market. The first approval locks the market's side, and evidence for the opposite side is blocked. | `src/rules.ts`, `src/side.ts` |
| 7 | Judge-fetch preflight. It does a plain GET with no JavaScript. X, Reddit and other login-walled sites are refused without fetching. It checks paywall text, JS-only pages, the content type, and whether the key text is on the page. If the link fails, it falls back to pasted key text plus a dated PDF capture (at most 3 files). | `src/preflight.ts`, `src/pdf.ts` |
| 8 | Note drafter. Each note gives `As of YYYY-MM-DD: fact`, the source, the pasted key text when needed, and which side it points to. Length is capped. | `src/drafter.ts` |
| 9 | Human approval queue: `list`, `show`, `set-side`, `attach`, `approve`, `reject`. | `src/queue.ts`, `src/cli.ts` |
| 10 | Idempotent submit (dry run or live), plus `sync` (`listSubmissions`). | `src/submit.ts` |
| 11 | Learning from verdict reasons. It tags each reason (duplicate, unreadable, undated, irrelevant, stale, weak source, and so on) and keeps counts per domain. From those it forces the fallback for domains the judge couldn't read and skips domains that are only ever rejected. | `src/learn.ts` |
| 12 | Qualification tracker (10 judged submissions across 3 markets, at most 3 per market) and the feedback-bounty log (drafts only). | `src/tracker.ts` |

## Setup
```bash
cd /workspace/firstsource
npm install
npm run typecheck
npm test            # unit + end-to-end tests against the local mock
```

### Environment (variable names only; never commit values)
| Var | Use |
|---|---|
| `COMPETITION_SITE_URL` | The competition site. The agent reads `/markets.json` from it. |
| `DELPHI_API_URL` | The evidence API base URL, including `/v1`. |
| `DELPHI_API_ACCESS_KEY` | The API key. `DELPHI_API_KEY` is used as a fallback. |
| `AGENT_ID`, `AGENT_MODEL` | Sent as `X-Agent-Id` and `X-Agent-Model` (1 to 64 printable ASCII characters). The defaults are `firstsource` and `rule-based (no LLM)`. The contest asks agents to send their ID, harness and model. |
| `FIRSTSOURCE_LIVE` | Must be `1` for any real submit. |
| `FIRSTSOURCE_ACCEPT_TERMS` | Must equal the current terms version for `accept-terms` to run. This step is for a human only. |
| `FIRSTSOURCE_SOURCES` | The sources config. Default: `config/sources.json`. |
| `FIRSTSOURCE_DATA_DIR` | The state directory. Default: `./data`. |
| `FIRSTSOURCE_MARKETS_FILE` | Reads `markets.json` from a local file instead of the site. |
| `FIRSTSOURCE_NOTE_MAX` | The note length cap, an integer from 200 to 20000. Default: 1200. |
| `FIRSTSOURCE_PER_MARKET` | How many new drafts to make per market on each scan, an integer from 1 to 3. Default: 2. Anything that isn't an integer is refused. |

## Try it on the mock (no network, no real API)
```bash
npm run mock &                       # serves /markets.json, source pages and /v1 on 127.0.0.1:8787
                                     # (keep port 8787: config/sources.mock.json points at it)
export COMPETITION_SITE_URL=http://127.0.0.1:8787 DELPHI_API_URL=http://127.0.0.1:8787/v1 \
       DELPHI_API_ACCESS_KEY=mock-key-not-a-secret FIRSTSOURCE_SOURCES=config/sources.mock.json \
       FIRSTSOURCE_DATA_DIR=/tmp/fs-demo
npm run fs -- markets
npm run fs -- scan --verbose
npm run fs -- list pending
npm run fs -- show <id>
npm run fs -- approve <id>
npm run fs -- submit --all-approved          # dry run
npm run fs -- status
```

## Day-one runbook: 25 Nov 2026, 18:00 (UTC+1) = 17:00 UTC
1. **Sanity:** `cd /workspace/firstsource && npm test`. Every test should pass.
2. **Read the agent guide**, then compare it with the "Assumptions" section below. Mainly check the `/markets.json` fields, the verdict values, the note length limit, the file types allowed, and whether X links are acceptable.
3. **Set the env in your own terminal.** Paste the key yourself so it never appears on screen, in history, or in chat:
   ```bash
   export COMPETITION_SITE_URL='<from guide>' DELPHI_API_URL='<from guide, ends in /v1>'
   read -rs DELPHI_API_ACCESS_KEY && export DELPHI_API_ACCESS_KEY
   npm run fs -- config            # apiKey must show "(set)"
   ```
4. **Terms (you do this yourself):** run `npm run fs -- terms` and read the URL it prints. If you agree, run
   `FIRSTSOURCE_ACCEPT_TERMS=<version> npm run fs -- accept-terms`, or accept them on the competition site.
5. **Markets:** run `npm run fs -- markets`. For any source that `scan` reports without a URL, open the official page yourself and add its **verified** URL (plus any release calendar or regional pages) to `config/sources.json`.
6. **Draft:** run `npm run fs -- scan --verbose`, then `npm run fs -- list pending`, then `npm run fs -- show <id>` for each item.
   - Fix the side if needed: `set-side <id> YES|NO`.
   - Add a real dated screenshot when a link is in fallback mode: `attach <id> shot.png`. `approve` prints a warning when a fallback item has no screenshot. Accepted file types are `.pdf`, `.png`, `.jpg`/`.jpeg`, `.csv` and `.txt`, the types the FAQ lists. Item ids can be shortened to a unique prefix of at least 4 characters.
   - Then `approve <id>` or `reject <id> <reason>`.
7. **Dry run:** run `npm run fs -- submit --all-approved` and check the JSON files in `data/dryruns/`.
8. **Live, one item at a time, only with the owner's go:** `FIRSTSOURCE_LIVE=1 npm run fs -- submit <id> --live`
9. **After judging:** run `npm run fs -- sync`, then `npm run fs -- status` (qualification and slots), then `npm run fs -- lessons`.
10. **Keep going:** markets are added every few days. Re-run `scan` after each watched release date (`status` lists them). The goal is at least 10 judged submissions across at least 3 markets before **11 Dec 2026, 17:00 UTC**.

Commands that only read from the API: `terms`, `limits`, `entry <market>`, `sync`.

## Tested (locally, against the mock)
54 tests in `test/` cover:
- dedup and novelty
- the one-side lock
- the per-market cap, both local and from `remainingOnMarket`
- the market picker's spread
- the qualification tracker and feedback log
- the learning policies
- dates, side calls, extraction, the drafter, and source planning
- preflight against a real local HTTP server: readable, paywall, JS-only, 404, image, PDF, redirect, X/Reddit refused with no network call, and an unreachable host

`test/review.test.ts` adds regression tests for every bug fixed in the 20 Nov review: number parsing in the config, agent headers, API timeouts, the state lock and corrupt state, ambiguous ids, attachment checks, releasing the side lock, the side lock rebuilt from synced notes, the cutoff, the empty-page preflight, malformed `markets.json`, the cutoff timezone, no re-fetch of rejected facts, reconciling a submit that landed, and blocking a cross-run duplicate before sending.

The end-to-end test runs the whole pipeline: scan, novelty on rescan, approval, a dry run (asserting zero `POST /submissions`), live refused without the env flag, live refused before terms acceptance, mock-only terms acceptance, live submit and judging, an idempotent re-POST that returns the same submission, `sync`, the tracker, and refusal when the server says the market is full.

## Untested until the real API, and assumptions
- **The real endpoint, auth and contract.** The mock follows the SDK's paths, multipart fields (`note`, `links[]`, `files`, `marketAddress`), `termsVersion` and error envelope, but the server's behaviour is unknown.
- **The `/markets.json` shape.** We read only the starter's fields (`address`, `question`, `status`, `odds`, `evidenceCutoffAt`, `dataSources`). The status is assumed to be `"open"`, and odds are read as a fraction or a percent.
- **Verdict vocabulary.** The values of `SubmissionMarket.verdict` aren't published. Accepted versus rejected is a first estimate from keywords and the bounty. Every `judged` submission counts toward qualification no matter what the verdict was.
- **How the judge reads pages.** Preflight copies "basic fetch, no JS" as described, but the judge's real user agent, timeouts and PDF handling aren't known.
- **Note length, file size and per-file limits** beyond "3 files" aren't known. The FAQ lists "pdf, png, jpg, csv, text etc." as file types. The note cap defaults to 1200 characters.
- **PDF sources** pass preflight on status and type, but facts are **not** extracted from PDFs. Paste those by hand.
- **The fallback capture is a text PDF, not a screenshot.** Attach a real screenshot when the guide asks for one.
- **Side calls are heuristics.** Threshold questions compare figures, and event questions use outcome words. Low-confidence or unclear calls need a human, and the human approves every item anyway.
- **`listSubmissions` only shows our own account.** Other entrants' duplicates can't be seen in advance.
- **The real source pages for real markets** haven't been fetched. `config/sources.json` is empty on purpose, and URLs are never guessed.
- **Rate limits and `getLimits`** have only been tested against the mock.
