# FirstSource

FirstSource is an evidence-mining agent for the **Delphi Agent Arena: Evidence Mining** contest (Gensyn), listed at https://dorahacks.io/hackathon/2479/detail.

It finds **dated facts from each market's own settlement sources** before they spread elsewhere. It checks that the judge can actually read each link, and it puts every draft in front of a human before anything is sent.

It is built on `@gensyn-ai/gensyn-delphi-sdk@2.4.0` (`EvidenceClient`). The API calls follow the SDK's code in `dist/client/evidence.js` and the official `examples/evidence-starter`.

> Status: built and tested locally against a mock of the API only. The real API, key, `/markets.json`
> and agent guide are released when submissions open on **25 Nov 2026, 17:00 UTC**. See "Untested until the real API" below.

## What changed on 22 Nov 2026 (v0.2)
1. **Hard-to-fetch sources need pasted text and a dated screenshot.** X/Twitter, Reddit, other login-walled sites, common paywalled news sites, and any page where preflight finds a paywall, login wall or bot check all count as hard to fetch. You can add hosts with `hardToFetch` in `config/sources.json` or with `FIRSTSOURCE_HARD_HOSTS`. Evidence from these sources:
   - quotes the key text in the note,
   - gets a dated text-PDF capture,
   - and **must** carry a PNG/JPG screenshot that shows the URL and the date. `approve` and `submit` refuse the item without one, and `add-manual` won't queue it. The 3-file cap still applies.
   - **How the screenshot is made:** if Chrome or Chromium is installed, FirstSource captures it headlessly. It uses a throwaway profile and the DevTools protocol, with no npm dependency, and puts a banner above the page that reads `URL: …` and `Captured: YYYY-MM-DD HH:MM UTC`. With no browser, or with `FIRSTSOURCE_SCREENSHOT=off`, you attach your own screenshot (`attach <id> shot.png`, or `add-manual … --screenshot shot.png`).
   - **X usually blocks headless browsers.** From the box, X returned `ERR_HTTP_RESPONSE_CODE_FAILURE`, so for X posts expect to take the screenshot yourself.
2. **`add-manual`** queues evidence from a page you read yourself, such as an X post, a Reddit thread or a paywalled article. You paste the key text, and FirstSource drafts the note, makes the capture and adds the screenshot.
3. **Same-key retries.** Each queued item stores a deterministic `Idempotency-Key`, `uuidFromSeed(item id)`, where the item id comes from the market plus the fact fingerprint. On a timeout, a dropped connection, a 5xx or a retryable API error, a live submit:
   - first checks `GET /submissions?market=…` and, if the send already landed, marks the item submitted without re-sending,
   - otherwise resends with the **same** key, up to `FIRSTSOURCE_MAX_ATTEMPTS` tries (default 3).
   - A new key is never created. Every attempt is recorded in `item.attempts`. If the API ever echoes `idempotencyKey` on list entries, that is used as the match first.
4. **Feedback-bounty prep (local only).**
   - **The log:** judge verdict rationales and agent failures go to `data/feedback-log.jsonl`. Failures include fetch failures, unreadable sources, API and network errors, retries and failed screenshots. Anything that looks like a credential is redacted.
   - **The draft:** `feedback draft` writes concise, deduplicated notes to `data/feedback-draft.md` for you to review.
   - **Nothing is sent.** SDK 2.4.0 has no feedback endpoint, so send the reviewed notes yourself through the official form.
5. **Curated sources.** `config/sources.json` now lists 67 verified public primary sources and official calendars across macro, crypto, tech, sports and politics, with global coverage. See "Sources" below.
6. **RSS/Atom feeds** are parsed item by item. A fact cites the **item's link** and date, never the feed URL. Preflight used to wrongly refuse `application/rss+xml`, and that is fixed.
7. **Agent headers.** `X-Agent-Id`, `X-Agent-Harness` and `X-Agent-Model` are sent on every call. The harness is now configurable with `AGENT_HARNESS` (default `firstsource/0.2 (node; @gensyn-ai/gensyn-delphi-sdk 2.4.0)`), and the mock test checks that all three arrive.

### New commands
```bash
npm run fs -- add-manual <market> <url> --date YYYY-MM-DD --text "key text quoted from the page" [--side YES|NO] [--screenshot shot.png] [--question "..."] [--cutoff ISO]
npm run fs -- detach <id> <file|n>          # free a slot (max 3 files) before attaching a screenshot
npm run fs -- feedback draft [--out f.md]   # deduplicated notes from data/feedback-log.jsonl; never sent
```
`attach` now redrafts the note and tells you whether a required screenshot is still missing. `config` shows which browser, if any, will take screenshots.

## Safety defaults
- **Dry run by default.** `submit` writes the exact request to `data/dryruns/` and sends nothing.
- **A live submit needs all of the following:** `FIRSTSOURCE_LIVE=1`, the `--live` flag, an item a human `approve`d, terms already accepted on the account, `EntryState.canSubmit`, a free slot on the market (at most 3), the market's locked side, and a fact that isn't a duplicate.
- **The terms are never accepted automatically.** `accept-terms` runs only when the operator sets `FIRSTSOURCE_ACCEPT_TERMS` to the exact current version.
- **The key is never printed.** `config` shows only `(set)` or `(unset)`.
- **Every submit is idempotent.** The `Idempotency-Key` is derived from the item id and stored when the item is queued. Retries after a timeout or network error check `GET /submissions` first, then resend with the same key, so they can't create a second submission.
- **Hard-to-fetch evidence needs a screenshot.** Items from X, Reddit, paywalls and login walls can't be approved or submitted without a PNG/JPG screenshot showing the URL and date.
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
| `AGENT_HARNESS` | Sent as `X-Agent-Harness`, 1 to 64 printable ASCII characters. Default: `firstsource/0.2 (node; @gensyn-ai/gensyn-delphi-sdk 2.4.0)`. |
| `FIRSTSOURCE_HARD_HOSTS` | Extra hard-to-fetch hosts, comma separated. They are added to the built-ins and to `hardToFetch` in the sources config. |
| `FIRSTSOURCE_SCREENSHOT` | `auto` (the default) captures with headless Chrome/Chromium when one is found. `off` means you attach screenshots yourself. |
| `FIRSTSOURCE_CHROME` | Path to the Chrome/Chromium binary to use for screenshots. |
| `FIRSTSOURCE_MAX_ATTEMPTS` | Live send attempts on a timeout or network error, all with the same key. An integer from 1 to 5. Default: 3. |
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
   - For an X post, Reddit thread or paywalled article you read yourself, run `add-manual <market> <url> --date … --text "…"`. Add `--screenshot shot.png` if no browser is available.
   - Add a real dated screenshot when a link is in fallback mode: `attach <id> shot.png`. Items marked "screenshot required" can't be approved without one. `approve` prints a warning when a fallback item has no screenshot. Accepted file types are `.pdf`, `.png`, `.jpg`/`.jpeg`, `.csv` and `.txt`, the types the FAQ lists. Item ids can be shortened to a unique prefix of at least 4 characters.
   - Then `approve <id>` or `reject <id> <reason>`.
7. **Dry run:** run `npm run fs -- submit --all-approved` and check the JSON files in `data/dryruns/`.
8. **Live, one item at a time, only with the owner's go:** `FIRSTSOURCE_LIVE=1 npm run fs -- submit <id> --live`
9. **After judging:** run `npm run fs -- sync`, then `npm run fs -- status` (qualification and slots), then `npm run fs -- lessons`. `sync` also logs the judge's rationales. Run `npm run fs -- feedback draft` and read `data/feedback-draft.md` before sending anything through the official feedback form.
10. **Keep going:** markets are added every few days. Re-run `scan` after each watched release date (`status` lists them). The goal is at least 10 judged submissions across at least 3 markets before **11 Dec 2026, 17:00 UTC**.

Commands that only read from the API: `terms`, `limits`, `entry <market>`, `sync`.

## Tested (locally, against the mock)
74 tests in `test/`: 73 run by default, and 1 real-browser screenshot test runs only with `FIRSTSOURCE_TEST_SCREENSHOT=1`. They cover:
- dedup and novelty
- the one-side lock
- the per-market cap, both local and from `remainingOnMarket`
- the market picker's spread
- the qualification tracker and feedback log
- the learning policies
- dates, side calls, extraction, the drafter, and source planning
- preflight against a real local HTTP server: readable, paywall, JS-only, 404, image, PDF, redirect, X/Reddit refused with no network call, and an unreachable host

`test/improvements.test.ts` (22 Nov) covers:
- hard hosts and screenshot rules
- `add-manual` refusing without a screenshot, then accepting a user screenshot or an automatic capture
- the 3-file cap and `detach`
- paywalled scan items blocked until they have a screenshot
- the same-key retry against the mock with injected faults: the connection drops after landing, the client times out after landing, the connection drops before landing, the list lags so a resend gets the same submission back, and an attempt that gives up then succeeds in a later run with the same key
- the feedback log, redaction, and deduplicated draft, plus the CLI writing the draft with no API
- `config/sources.json` validity and topic matching
- RSS/Atom parsing and preflight
- agent headers

`test/review.test.ts` adds regression tests for every bug fixed in the 20 Nov review: number parsing in the config, agent headers, API timeouts, the state lock and corrupt state, ambiguous ids, attachment checks, releasing the side lock, the side lock rebuilt from synced notes, the cutoff, the empty-page preflight, malformed `markets.json`, the cutoff timezone, no re-fetch of rejected facts, reconciling a submit that landed, and blocking a cross-run duplicate before sending.

The end-to-end test runs the whole pipeline: scan, novelty on rescan, approval, a dry run (asserting zero `POST /submissions`), live refused without the env flag, live refused before terms acceptance, mock-only terms acceptance, live submit and judging, an idempotent re-POST that returns the same submission, `sync`, the tracker, and refusal when the server says the market is full.

## Untested until the real API, and assumptions
- **The real endpoint, auth and contract.** The mock follows the SDK's paths, multipart fields (`note`, `links[]`, `files`, `marketAddress`), `termsVersion` and error envelope, but the server's behaviour is unknown.
- **The `/markets.json` shape.** We read only the starter's fields (`address`, `question`, `status`, `odds`, `evidenceCutoffAt`, `dataSources`). The status is assumed to be `"open"`, and odds are read as a fraction or a percent.
- **Verdict vocabulary.** The values of `SubmissionMarket.verdict` aren't published. Accepted versus rejected is a first estimate from keywords and the bounty. Every `judged` submission counts toward qualification no matter what the verdict was.
- **How the judge reads pages.** Preflight copies "basic fetch, no JS" as described, but the judge's real user agent, timeouts and PDF handling aren't known.
- **Note length, file size and per-file limits** beyond "3 files" aren't known. The FAQ lists "pdf, png, jpg, csv, text etc." as file types. The note cap defaults to 1200 characters.
- **PDF sources** pass preflight on status and type, but facts are **not** extracted from PDFs. Paste those by hand.
- **Screenshots** are real PNGs when a headless Chrome/Chromium works on the machine. X usually blocks headless browsers, and other sites may too. Check every screenshot before you approve, and replace it with your own if it shows a login wall.
- **Side calls are heuristics.** Threshold questions compare figures, and event questions use outcome words. Low-confidence or unclear calls need a human, and the human approves every item anyway.
- **`listSubmissions` only shows our own account.** Other entrants' duplicates can't be seen in advance.
- **The curated sources are general.** The 67 entries in `config/sources.json` were checked on 22 Nov 2026, but they aren't any market's declared settlement source. The market's own `dataSources` always come first, so add each market's verified pages on day one.
- **Feedback endpoint.** SDK 2.4.0 has no feedback method, so `feedback draft` only writes a local file. If the agent guide later documents an endpoint, sending stays a human decision.
- **Rate limits and `getLimits`** have only been tested against the mock.

## Sources (`config/sources.json`, checked 22 Nov 2026)
- **`official`** entries (kind `primary`) are fetched when their `match` regex hits the market question.
- **`calendars`** entries become **watches** for future release dates.
- **`regional`** entries are added when the question names the place (Nigeria, UK, Japan, Canada, India, South Africa, Kenya, Australia, Germany, Eurozone).
- **`type`** tells you what each URL is: **rss** is a feed (each item cites its own article link), **page** is an HTML newsroom or release page, and **calendar** is a release or event schedule.

**How they were checked:**
- Every URL was fetched with `curl`, and again with FirstSource's own plain fetch and preflight, which is the judge's view. All 67 returned HTTP 200 with readable server-rendered text.
- BLS, RBA, IMF and SEC EDGAR returned 403 to a browser-like user agent but 200 to FirstSource's plain user agent.
- SEC asks automated clients to send a descriptive user agent. FirstSource sends `FirstSource/0.2 (...)`.

| Topic | Type | Label | URL |
|---|---|---|---|
| macro | calendar | ABS release calendar (Australia) | https://www.abs.gov.au/release-calendar/future-releases |
| macro | calendar | BEA release schedule | https://www.bea.gov/news/schedule |
| macro | calendar | BLS release schedule | https://www.bls.gov/schedule/news_release/ |
| macro | calendar | Bank of Canada policy rate announcements | https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/ |
| macro | calendar | BoE upcoming MPC dates | https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates |
| macro | calendar | BoJ Monetary Policy Meeting schedule | https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm |
| macro | calendar | ECB Governing Council meeting calendar | https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html |
| macro | calendar | Eurostat release calendar | https://ec.europa.eu/eurostat/news/release-calendar |
| macro | calendar | FOMC meeting calendar | https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm |
| macro | calendar | NBS China release calendar | https://www.stats.gov.cn/english/PressRelease/ReleaseCalendar/ |
| macro | calendar | ONS release calendar | https://www.ons.gov.uk/releasecalendar |
| macro | calendar | RBA Board meeting schedule | https://www.rba.gov.au/schedules-events/board-meeting-schedules.html |
| macro | page | Central Bank of Nigeria | https://www.cbn.gov.ng/ |
| macro | page | Deutsche Bundesbank press releases | https://www.bundesbank.de/en/press/press-releases |
| macro | page | EIA Weekly Petroleum Status Report | https://www.eia.gov/petroleum/supply/weekly/ |
| macro | page | Eurostat euro indicators | https://ec.europa.eu/eurostat/web/euro-indicators |
| macro | page | IMF World Economic Outlook | https://www.imf.org/en/Publications/WEO |
| macro | page | National Bureau of Statistics (Nigeria) | https://nigerianstat.gov.ng/ |
| macro | page | Reserve Bank of India press releases | https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx |
| macro | page | South African Reserve Bank | https://www.resbank.co.za/en/home |
| macro | page | Statistics Canada, The Daily | https://www150.statcan.gc.ca/n1/dai-quo/index-eng.htm |
| macro | rss | BEA news releases (US GDP, PCE) | https://apps.bea.gov/rss/rss.xml |
| macro | rss | BLS latest releases (US CPI, jobs, PPI) | https://www.bls.gov/feed/bls_latest.rss |
| macro | rss | Bank of England news | https://www.bankofengland.co.uk/rss/news |
| macro | rss | Bank of Japan what's new | https://www.boj.or.jp/en/rss/whatsnew.xml |
| macro | rss | ECB press releases | https://www.ecb.europa.eu/rss/press.html |
| macro | rss | EIA Today in Energy | https://www.eia.gov/rss/todayinenergy.xml |
| macro | rss | Federal Reserve press releases | https://www.federalreserve.gov/feeds/press_all.xml |
| macro | rss | ONS release calendar feed (UK) | https://www.ons.gov.uk/releasecalendar?rss |
| crypto | page | Bitcoin Core releases | https://bitcoincore.org/en/releases/ |
| crypto | page | CFTC press releases | https://www.cftc.gov/PressRoom/PressReleases |
| crypto | page | ethereum.org roadmap | https://ethereum.org/en/roadmap/ |
| crypto | rss | Bitcoin Core blog | https://bitcoincore.org/en/rss.xml |
| crypto | rss | CoinDesk (news; secondary source) | https://www.coindesk.com/arc/outboundfeeds/rss/ |
| crypto | rss | Ethereum Foundation blog | https://blog.ethereum.org/feed.xml |
| crypto | rss | SEC EDGAR latest filings (Atom) | https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=&company=&dateb=&owner=include&start=0&count=40&output=atom |
| crypto | rss | SEC press releases | https://www.sec.gov/news/pressreleases.rss |
| tech | page | Anthropic news | https://www.anthropic.com/news |
| tech | rss | Android Developers blog | https://android-developers.googleblog.com/feeds/posts/default |
| tech | rss | Apple Newsroom | https://www.apple.com/newsroom/rss-feed.rss |
| tech | rss | GitHub changelog | https://github.blog/changelog/feed/ |
| tech | rss | Google (The Keyword blog) | https://blog.google/rss/ |
| tech | rss | Meta newsroom | https://about.fb.com/news/feed/ |
| tech | rss | Microsoft official blog | https://blogs.microsoft.com/feed/ |
| tech | rss | NASA news releases | https://www.nasa.gov/news-release/feed/ |
| tech | rss | NVIDIA newsroom | https://nvidianews.nvidia.com/releases.xml |
| tech | rss | OpenAI news | https://openai.com/news/rss.xml |
| tech | rss | Samsung Newsroom | https://news.samsung.com/global/feed |
| sports | calendar | Bundesliga matchday | https://www.bundesliga.com/en/bundesliga/matchday |
| sports | calendar | CAF (Confederation of African Football) | https://www.cafonline.com/ |
| sports | calendar | Formula 1 2026 calendar | https://www.formula1.com/en/racing/2026 |
| sports | calendar | ICC fixtures and results | https://www.icc-cricket.com/fixtures-results |
| sports | calendar | LaLiga calendar | https://www.laliga.com/en-GB/laliga-easports/calendar |
| sports | calendar | MLB schedule | https://www.mlb.com/schedule |
| sports | calendar | NBA schedule | https://www.nba.com/schedule |
| sports | calendar | NFL schedule | https://www.nfl.com/schedules/ |
| sports | calendar | NHL schedule | https://www.nhl.com/schedule |
| sports | calendar | Premier League fixtures | https://www.premierleague.com/fixtures |
| sports | calendar | UEFA Champions League fixtures and results | https://www.uefa.com/uefachampionsleague/fixtures-results/ |
| politics | calendar | IFES ElectionGuide elections calendar (NGO, global) | https://www.electionguide.org/elections/ |
| politics | page | Australian Electoral Commission | https://www.aec.gov.au/ |
| politics | page | European Parliament election results | https://results.elections.europa.eu/ |
| politics | page | Federal Returning Officer (Germany) | https://www.bundeswahlleiterin.de/en/ |
| politics | page | INEC Nigeria | https://inecnigeria.org/ |
| politics | page | Kenya IEBC | https://www.iebc.or.ke/ |
| politics | page | US Election Assistance Commission | https://www.eac.gov/ |
| politics | page | US Federal Election Commission | https://www.fec.gov/ |

**Dropped while checking:**
- **404:** the Destatis release calendar (`https://www.destatis.de/EN/Service/Calendar/_node.html`) and IFES ElectionGuide `/elections/upcoming/`. The latter was replaced by `https://www.electionguide.org/elections/`.
- **Refuse a plain fetch (403/429):**
  - OPEC press releases (`https://www.opec.org/opec_web/en/press_room/28.htm`)
  - Tesla IR (`https://ir.tesla.com/`)
  - the ATP tournaments calendar (`https://www.atptour.com/en/tournaments`)
  - the UK Electoral Commission (`https://www.electoralcommission.org.uk/`)
  - Brazil TSE (`https://www.tse.jus.br/`)
  - Japan MIC elections (`https://www.soumu.go.jp/senkyo/`)
  - Solana news (`https://solana.com/news`, 429)
  - the Coinbase blog (`https://www.coinbase.com/blog`) and the Electoral Commission of South Africa (`https://www.elections.org.za/`). Both load in curl but return 403 to Node's fetch.
- **JavaScript-only pages** (HTTP 200 but no server-rendered text, so neither FirstSource nor the judge can read them):
  - the Stats SA release calendar
  - Banco Central do Brasil Copom
  - the Election Commission of India
  - Elections Canada
  - the FIFA World Cup 2026 page
  - SpaceX launches

  These still work as evidence through `add-manual` with a screenshot.
