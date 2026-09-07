# Simply Why

Session recording, and eventually the thing that makes it worth having: an
explanation of *why* a number moved, with evidence from the code, the docs and
the meetings that caused it.

**Phase 1 is done and working.** You can record a session and watch it back.

---

## Run it

```bash
npm install
npm run build:recorder
npm run dev
```

Open http://localhost:3000, create a project, and you get two things: a
one-line snippet to paste into a site, and a private dashboard link.

There's a test page at `/demo.html` wired to trip every detector — put your
install key in its script tag and click around.

No database to install. It uses PGlite (Postgres compiled to WASM) stored in
`app/data/pg`. When you deploy, set `DATABASE_URL` to a real Postgres
connection string — the SQL is identical, so there is no migration.

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

db/schema.sql          all nine tables, including the ones phases 3–6 need
```

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

## What's next

Phase 2 is largely done — the detectors landed early because they were cheap
while the recorder was already open.

- **Phase 3** — GitHub connector: commits, diffs, deploy times, and the repo
  lexicon that maps "the phone field" to `PhoneInput.tsx`
- **Phase 4** — the investigator, on exact evidence only: time window, code
  path, counterfactual across builds, confidence, and the three ways to
  decline. This is the product.
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
