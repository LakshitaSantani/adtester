# Simply Why

Session recording, and eventually the thing that makes it worth having: an
explanation of *why* a number moved, with evidence from the code, the docs and
the meetings that caused it.

It works out which code change caused a problem, shows the evidence, scores how
sure it is, and refuses to answer when the evidence isn't there.

---

## Run it

Needs Node 20 or newer. Nothing else — no database to install, no Docker.

```bash
git clone <this repo>
cd Simplyyyywhyyy
npm install
npm run build:recorder
cd app && npm run dev
```

Open the URL it prints (usually http://localhost:3000), give the project a
name, and you land on a setup page.

The database is PGlite — Postgres compiled to WebAssembly, stored in
`app/data/pg`. Delete that folder to start over.

### Try it without connecting anything

```bash
curl -X POST http://localhost:3000/api/dev/seed   -H 'Content-Type: application/json'   -d '{"token":"<your admin token>","scenario":"split"}'
```

That builds a worked example with a known correct answer: five commits, one of
which really did cause the problem. Press **Look for problems now** on the
reports page and it should name `a3f91c2` at about 0.89.

Other scenarios: `no-release` (no build stamps, as imported data usually
looks), `no-split` (everyone updated at once), `diffuse` (should refuse).

### Connect your own data

Four things on the setup page, two required:

| | | |
|---|---|---|
| **Recordings** | PostHog host, project id, personal API key (`phx_`) | required |
| **Code** | GitHub repo, plus a read-only token for private ones | required |
| **Context** | PRDs and transcripts — `.md`, `.txt`, `.vtt`, `.srt` | optional |
| **Analysis** | Anthropic API key | optional |

Without the Anthropic key you still get findings, evidence and confidence
scores. What you lose is the written explanation and the suggested patch.

---

## If you're testing this for us

The question is **whether the analysis is correct**, not whether the app is
pretty. Two things make your answer useful:

**Judge each finding.** Every report has a *Was this right?* button. The note
matters more than the yes or no — "right commit, wrong reason" is a completely
different failure from "not even close", and they need different fixes.

**Send back the results.** There's a *Download the results* link on the reports
page. It contains the findings, the confidence scores, the signal breakdowns
and your verdicts — and deliberately no credentials, no recordings and no text
from your documents, so it's safe to pass on.

The reports page also shows how often it was right at each confidence level.
That table is the actual product claim; if it says 0.9 and is right half the
time, the scoring is wrong and we need to know.

**Two links.** The one starting `a_` configures things and can spend your
Anthropic credit. The one starting `v_` only reads. Share the second one.

---

## What exists

```
packages/recorder/     the script that runs on a customer's site
  src/session.ts       lifecycle, flush triggers, retries
  src/privacy.ts       masking decisions and URL redaction
  src/signals.ts       rage clicks, dead clicks, field retries, errors
  src/buffer.ts        event buffer and its size caps
  src/navigation.ts    SPA navigation detection

app/                   Next.js — ingest, dashboard and player in one process
  src/app/api/         session start, event ingest, event streaming
  src/app/p/[token]/   the dashboard and the replay page
  src/lib/storage.ts   the ONLY module that knows where recordings live
  src/lib/github.ts    commits, diffs, PRs, deployments
  src/lib/lexicon.ts   routes, aliases, the import graph
  src/lib/candidates.ts  session -> the commits that could have affected it
  src/lib/posthog.ts     importing an existing PostHog account
  src/lib/rrweb-signals.ts  reading signatures out of a raw event stream
  src/lib/session-timeline.ts  a recording, as a description of what someone did
  src/lib/intent.ts      linking a change to what the team said they'd build
  src/lib/analyst.ts     reads the diff and the recording, writes the fix
  src/lib/auth.ts        the view / admin split
  src/lib/crypto.ts      credentials encrypted at rest
  src/lib/symptoms.ts    what started going wrong, and where
  src/lib/counterfactual.ts  the same symptom on builds with and without a change
  src/lib/confidence.ts  six named signals, and the cap
  src/lib/investigate.ts the pipeline, and the three ways it refuses
  src/lib/worker.ts    the job loop and its tasks
  src/lib/jobs.ts      a queue that is just a table

db/schema.sql          all twelve tables, including the ones phases 4-6 need
scripts/db-check.mjs   resets the local database if a hard kill damaged it
```

## Phase 3 — connecting the code

One GitHub authorisation gives two sources: the commit history (what changed,
when) and the codebase itself (how the system is wired).

**The lexicon** maps files to what a person would call them. `PhoneInput.tsx`
gets the aliases "phone input", "phone", "input", so a transcript saying "the
phone field" can reach it in phase 5. Routes come from framework conventions —
Next.js app and pages routers, SvelteKit, Remix.

**The import graph** answers the question phase 4 needs: given the URL a
session was on, which files could possibly be involved? Three hops out from
the route file, which covers page -> feature component -> shared helper.

**Deploy times** matter more than merge times: code merged Friday and deployed
Tuesday cannot have broken anything on Monday. They come from GitHub
Deployments where a team publishes them, and otherwise are inferred from the
recordings — the first session reporting a build is direct evidence it was
live by then. That second source is usually the better one, because it
reflects when code actually reached people.

**What it produces**, entirely from database queries with no model involved:

```
5 shipped in the window -> 1 route matched /checkout
                        -> 4 files reachable
                        -> 2 candidates left
```

Try it without a GitHub round trip: `POST /api/dev/seed` with your view token
seeds the worked example from the design docs and returns a session id.

### The recorder

Built on rrweb, with the browser-handling logic modelled on Milana's SDK —
its reasoning about visibility, unload and the back/forward cache is sound and
hard-won. What's deliberately not copied: server-side sampling, the session
restart protocol, multi-tenant credentials and the health metrics endpoint,
all of which exist to serve thousands of customers at scale.

- Starts inside `requestIdleCallback`, and only once the page has a real
  viewport — see the note below
- Flushes every 10 seconds, when the buffer passes 512 KB, and with
  `keepalive` when the tab is hidden
- Sends a small close ping on `pagehide`, skipped when the page is only being
  frozen into the back/forward cache
- Retries on 5s / 15s / 30s / 60s / 5min, then stops rather than hammering
  someone else's site forever
- gzips payloads where the browser supports it
- Every entry point is wrapped so a failure inside the recorder can never
  throw into the host page

### Privacy

**Every input value is masked by default.** Stricter than Milana's default,
deliberately: Milana ships to customers with contracts and a rollout plan;
this gets pasted onto a site by someone trying it out on a Tuesday.

Precedence, strongest first — the order is what guarantees that turning
masking up can't be undone by turning something else on:

1. `swy-block` — not recorded at all
2. `password` / `tel` / `email` — always masked, unreachable by any setting
3. `swy-mask` — explicitly marked private
4. the masking level — masks all inputs unless a subtree opts out
5. `swy-unmask` — reveals a field you know is safe

URLs always lose their fragment, and query params matching a denylist
(`token`, `password`, `secret`, `key`, `auth`, `csrf`, …) become
`--redacted--`. A caller's own patterns extend that list; they can never
shrink it.

Kill switch, for a tester who wants you gone right now without a redeploy:

```js
localStorage.setItem("swy_off", "1")
```

### Signatures

Recorded sessions are only useful if you know which to watch. Five detectors
label each session: rage clicks, dead clicks, field retries, JavaScript errors
and failed network calls. All verified working end to end.

---

## The one field that matters

```html
<script src="/rec.js" data-swy-key="key_..." data-swy-release="GIT_SHA" async></script>
```

`data-swy-release` is the join key between a recording and the code that was
running. It's what turns "this broke" into "this commit broke it", it costs
one line, and **it cannot be backfilled** — every session recorded without it
is permanently unattributable.

Set it from CI. It's the whole basis of phases 3 onwards.

---

## Two things worth knowing

**The viewport gate.** rrweb stamps the document's dimensions into its first
event and the player sizes the entire replay from it. Snapshot a page that is
hidden or not yet laid out and you record a viewport a few pixels wide — every
replay of that session is then unwatchable, and it cannot be repaired
afterwards. This bit us during development in a hidden browser pane, and it
happens in the wild with background-tab preloads, prerendered pages and tabs
restored at startup. So the recorder waits for the page to be visible and
measurable, with a 20-second ceiling after which it records anyway.

**The dashboard link is not authentication.** Anyone with the view token can
watch the recordings, and that link will end up in a Slack message. It's an
honest trade for a handful of design partners on staging sites. It stops being
honest the moment someone points this at real customers — that's the trigger
for real accounts.

---

## Phase 4 — the investigator

The product. Finds a symptom, narrows the suspects, and either names a cause
with a confidence score or explains why it can't.

**Nothing here uses a model.** Every step is a database query over exact
edges. That's deliberate: if the causal core is wrong, richer storytelling on
top only makes it wrong more convincingly.

**Where the number comes from.** Six named signals, each stored as its own row
so the breakdown is inspectable and old investigations can be re-scored when
the weights improve:

```
Counterfactual   55% of 40 sessions with the change hit this, vs 7% of 15 without  +0.45
Code path        1 of 1 changed files are on this page's path                      +0.20
Onset            the symptom started 1.0 hours after this deployed                 +0.20
Volume           23 sessions affected                                              +0.12
Other candidates 1 other change could explain this equally well                    -0.08
                                                                                    0.89
```

**Only the counterfactual can license high confidence.** Everything else is
circumstantial — plenty of changes ship before a problem and touch code the
page uses. When everyone moved to the new build at once there is no comparison
to make, so the score is capped at 0.70 and the report says why.

The same seeded scenario, three ways:

| Scenario | Result |
|---|---|
| Some users still on the old build | **claimed, 0.89** — the real cause wins; the decoy commit, present in both builds, gets no counterfactual and drops to 0.35 |
| Everyone on the new build at once | **claimed, 0.58** — capped, and it says so |
| Signature on five different pages | **declined** — can't be pinned to any one page's code |
| A commit that *fixed* the symptom | **declined** — 3% of sessions on builds carrying it hit this against 35% without, so the evidence against it outweighs everything pointing at it |
| Site traffic collapses, checkout unchanged | **silent** — checkout failed at 10% last week and 10% today; only the homepage campaign stopped |

Try them: `POST /api/dev/seed` with `{"scenario": "split" | "no-split" |
"diffuse" | "fix-commit" | "traffic-shift" | "spa" | "safari" | "backend" |
"priority" | "no-release"}`.

The last two are there because both failures are invisible from the outside.
A scorer that treats evidence *against* a commit as merely absent evidence
still names the repair as the cause; a rate divided by site-wide sessions
turns a marketing decision into a regression report. Neither produces an
error, and both produce a confident sentence.

**It refuses in four situations**, and that's the point: too widespread to pin
down, nothing shipped that touches the page, candidates that can't be
separated, and evidence too thin to assert. A product that always answers is a
product that is often wrong — and with engineers as the audience, one
confidently wrong root cause ends the relationship.

---

## What's next

- **Phase 5** — PRDs and transcripts, so a report can say *"Priya raised this
  in the Sept 4 planning call"*
- **Phase 6** — real accounts, fix suggestions as diffs, and a hit-rate page

Deliberately sequenced by incident class, not by connector. Four half-built
connectors is the shallow version.

---

## Notes

- Recordings are one newline-delimited JSON file per session under
  `app/data/events/`. Everything reads them through `src/lib/storage.ts` so
  swapping to object storage is a change in one file.
- The job queue is a table in Postgres. No Redis. A failed job is a row you
  can look at.
- `app/data/` is gitignored — it holds real recordings.
- The embedded database does not survive a hard kill mid-write. `npm run dev`
  checks it first and resets it if needed; `npm run db:reset` does it manually.
  Production sets `DATABASE_URL` and never uses PGlite at all.
- The worker runs inside the web process locally, because only one process can
  open PGlite. Changing worker code needs a restart — a hot reload replaces the
  module but not the loop already running.
- Unauthenticated GitHub allows 60 requests an hour, which one repo sync will
  exhaust. Add a token.
