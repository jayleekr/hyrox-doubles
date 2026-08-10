# HYROX Doubles 2026

Two-person training tracker for the 15-week HYROX Doubles programme (2026-08-01 → race day 2026-11-13).

The Google Spreadsheet stays the source of truth. This repo adds two things on top of it:

- a **mobile web app** (installable PWA) for 10-second logging and a read-only overview
- a **CLI** (`bin/hyrox`) that reads the sheet, writes logs, and builds the daily and weekly briefs

Conversation and scheduling are not in here. [OpenClaw](https://docs.openclaw.ai) owns those: it
runs the Telegram bot, understands what you said, calls this CLI, and fires the 06:00 / 21:00
pushes. That split is deliberate — a language model reads Korean training talk far better than a
parser can, and this CLI is where a misread sentence gets caught before it reaches the sheet.

Nothing here replaces the sheet. Every write lands in the same cells you would have typed into by hand, so the sheet remains readable and hand-editable.

---

## How the sheet is used

Tab `15주 상세 일지 (2인 전용)`, rows **5–109**, one row per day (2026-08-01 … 2026-11-13, no gaps).
The row for a date is `5 + (date − 2026-08-01)` — column A is only used as a consistency check, never to locate a row.

This table is the answer to "which cells are safe to hand-edit". Anything marked **yes** has an
owner in this repo and may be rewritten under you.

| Column | Meaning | Written by the app |
|---|---|---|
| A–C | 날짜 / 주차 / 요일 | no |
| **D, F** | 목표 체중 (A / B) | **yes** — `hyrox goal --date` |
| **E, G** | 실체중 + 완료 (A / B) | **yes** |
| H–J | 훈련 영역 / 상세 계획 / 페이스 타겟 | no |
| **K, L** | 선수 A 대체운동 / 메모 | **yes** |
| **M, N** | 선수 B 대체운동 / 메모 | **yes** |
| **O, P, Q** | 선수 A 실측 페이스 / 시간 / RPE | **yes** (new) |
| **R, S, T** | 선수 B 실측 페이스 / 시간 / RPE | **yes** (new) |

Columns O–T are new. The original sheet has no place to record what actually happened —
only a completion checkbox — so progress toward the 4:15/km and 1:05 targets could not be measured.

The 완료 column holds two facts in one human-readable cell:

```
✅ 82.4kg          done, with body weight
✅ 완료             done, no weight given
[ ] 미완료 · 82.4kg  not done, weight given
[ ] 미완료          the sheet's original value
```

Both directions are covered by round-trip tests, and hand-typed variants (`완료`, `82.4 kg`, `done`) parse too.

Two further tabs hold the 목표 몸무게 the briefs and the weight trend are measured against:

| Tab | Cells | Written by the app |
|---|---|---|
| `목표 및 더블 운영 원칙` | B6 / C6 — 시즌 전체 목표 몸무게 | **yes** — `hyrox goal --weight` |
| `목표 및 더블 운영 원칙` | rows 7–10 and section 2 (운영 원칙) | no — authored prose, read verbatim |
| `15주 단계별 요약 (2인)` | D4:E7 — Phase 1–4 목표 몸무게 | **yes** — `hyrox goal --phase` |
| `15주 단계별 요약 (2인)` | everything else | no |
| `식단 기록` | D:K — 하루 4끼 × 2인 | **yes** — `hyrox meal` |
| `운영 방식 & 근거` | everything | no — written once by `scripts/add-approach-tab.mjs`, for humans |

The 식단 tab shares the log tab's rows exactly (5–109, same A/B/C prefix), so a date resolves
to one row by the same arithmetic and the same anchors. A second row convention would be a
second way to file an entry against the wrong day.

Meals are stored as text, not calories. A calorie figure lifted off a photo is a guess wearing
a number's clothes, and once it is in a column it gets averaged as though it were measured.

A target cell holding text no parser reads back — `82 (10월까지)`, `82~84`, `현재 체중 유지` —
is left alone: the write is refused rather than replacing what you wrote with a bare `82kg`.
This holds on all three target paths, including `goal --date` on the log tab, which is where
210 of the 220 writable target cells are. `--force` overrides it when the text really is
disposable.

The 실체중/완료 cells (E, G) are the one hand-editable pair a log *does* overwrite — a session
record must never be blocked by a note. It is not silent, though: whatever a person wrote
there is quoted back in the confirmation with a ⚠️, so it can be restored from that line alone.

---

## Setup

### 1. Prepare the sheet

```bash
npm install
node scripts/init-sheet.mjs            # checks row alignment, reports missing headers
node scripts/init-sheet.mjs --apply    # writes the O~T headers
```

The script refuses to continue if rows 5–109 no longer line up with the season dates.

### 2. Google credentials

**Local dev** — nothing to do if you already use the `gws` CLI; the app falls back to
`~/.config/gws/credentials.json`.

> ⚠️ **Check which account that credential belongs to.** Reads succeed for anyone with view
> access, so the app can look fully working right up until the first write, which then fails
> with a 403. If your `gws` CLI is signed in as a *different* Google account from the one that
> owns the spreadsheet — a work account versus a personal one, say — share the sheet with the
> signed-in account as **Editor**, or use the service-account path below.
> `npm run init-sheet` names both accounts and the missing permission when this happens.

**Production (and the cleanest local fix when the accounts differ)** — a service account.
It keeps the sheet out of any human account's Drive, and a server has no browser to log in
with anyway. With `gcloud` signed in as the sheet's owner:

```bash
gcloud projects create hyrox-doubles-2026 --name="HYROX Doubles 2026"
gcloud services enable sheets.googleapis.com --project=hyrox-doubles-2026
gcloud iam service-accounts create hyrox-bot --project=hyrox-doubles-2026 \
  --display-name="HYROX Doubles tracker"
gcloud iam service-accounts keys create key.json \
  --iam-account=hyrox-bot@hyrox-doubles-2026.iam.gserviceaccount.com \
  --project=hyrox-doubles-2026
```

Put the key on one line in `GOOGLE_SERVICE_ACCOUNT_JSON`, delete `key.json`, then **share the
spreadsheet with the service account's address as Editor** — this last step needs a browser,
because granting access requires edit rights on the file itself. Google will warn that the
address cannot receive email; that is expected.

`npm run init-sheet` loads `.env.local`, so it uses the service account as soon as the key is
there, and its 403 message names the exact account to share with.

### 3. Environment

```bash
cp .env.example .env.local
node -e "console.log(crypto.randomUUID())"   # once per person → PLAYER_A_KEY / PLAYER_B_KEY
```

Everything except the Google credentials and the two player keys is optional; see
[Degradation](#degradation) for what each missing piece costs.

### 4. OpenClaw

Chat, scheduling and natural language all belong to [OpenClaw](https://docs.openclaw.ai),
which already runs on this machine against the Claude Code CLI — so the conversational half
costs nothing per message beyond the existing subscription.

It runs as its own OpenClaw agent, **`hyrox`** (identity: Rox 🏃), deliberately separate from
whatever personal assistant also runs on the machine. Two people share this bot, so it gets its
own bot token, its own workspace, exactly one skill, and one tool:

```
agents.entries.hyrox
  workspace: ~/.openclaw/workspace-hyrox     # own IDENTITY.md / SOUL.md
  skills:    ["hyrox"]                        # this one and nothing else
  tools:     { allow: ["exec"] }              # enough to run bin/hyrox, nothing more
```

That is the whole isolation story: the training bot cannot reach another agent's mail,
calendar, notes or credentials, because it has neither the skills nor the tools to.

`exec` is deliberately the *only* tool, and in particular **`read` must not be added to make
photos work**. OpenClaw hydrates inbound image bytes itself, stages them into
`<workspace>/.openclaw-cli-images/` and attaches them to the prompt; no agent tool takes part.
An image that never arrives is an ingest problem upstream (see the `requireMention` note below),
and granting a two-person bot filesystem read access would not deliver a single extra pixel.

The skill lives at `~/.openclaw/workspace-hyrox/skills/hyrox/SKILL.md` and does one thing: teach
the agent how to turn a sentence into a `bin/hyrox` command. Verify it is loaded with:

```bash
openclaw skills info hyrox --agent hyrox    # → "hyrox ✓ Ready"
openclaw agents bindings                    # → hyrox <- telegram accountId=hyrox
```

Put each person's numeric Telegram user id in `TELEGRAM_USER_A` / `TELEGRAM_USER_B`. That is how
a message is attributed to a player: OpenClaw passes `--telegram <sender id>` and the CLI resolves
it, so who is logging is never inferred from the wording.

A group chat needs the chat id in **two** places — `groupAllowFrom` alone is not enough, because
the access check also requires the chat to appear in the `groups` map:

```jsonc
channels.telegram.accounts.hyrox.groups["-100…"] = { enabled: true, requireMention: false }
```

Without the `groups` entry the gateway logs `reason: "not-allowed"` and drops every group
message, sender allowlist notwithstanding.

`requireMention` is `false` on purpose, and it is the setting that costs the most when it is
wrong. With it on:

- a group message carrying **media** is consumed and discarded *before* the download runs
  unless its own caption mentions the bot, so photos never reach the agent and never appear in
  `~/.openclaw/media/inbound` — with no error shown to the sender;
- a session that arrives across several messages loses every message after the first addressed
  one, which is how a whole workout can go missing while the bot looks healthy;
- OpenClaw's own detectors for a kicked bot (403) and for Telegram privacy mode are both gated
  on `requireMention === false`, so a group configured with `true` is *structurally excluded*
  from the two checks that would have reported those outages.

The cost of `false` is noise, not exposure: `groupPolicy: "allowlist"` and `groupAllowFrom`
still decide who may be heard at all, and every message now wakes one agent turn. The skill's
silence rule (`NO_REPLY` unless the message is about training, asks a question, names Rox, or
carries an image) is what keeps that liveable, so the two changes belong together.

Until a message arrives, two things work regardless of the setting: send the photo with a
caption naming Rox, or send it as a **reply** to one of Rox's messages — a reply also recovers a
photo that was already dropped, because the media is re-fetched by `file_id` from the embedded
`reply_to_message`.

### 5. Run

```bash
npm run icons     # generates the PWA icons (no image dependencies)
npm run dev       # http://localhost:3210/?k=<PLAYER_A_KEY>
./bin/hyrox today # the CLI, against the real sheet
```

### 6. Schedule

Two OpenClaw automations, both in `Asia/Seoul`:

| Job | Time | Does |
|---|---|---|
| `hyrox-morning` | 06:00 daily | today's session; on Sundays also the previous week's review |
| `hyrox-nudge` | 21:00 daily | pings whoever has not logged; silent when there is nothing to say |

```bash
openclaw cron status            # scheduler health and job count
openclaw cron run <job-id>      # fire one now
```

There is no Vercel deployment and no cron secret: nothing is exposed to the internet except the
optional PWA, and the agent runs locally. The tradeoff is that the pushes depend on this machine
being awake.

---

## Using it

**App** — open your personal link once; the key is stored in `localStorage` and stripped from the
URL. Add to home screen to get the standalone app.

**Chat** — talk to the OpenClaw bot normally. There is no syntax to learn:

```
오늘 다 했어 82.4kg 페이스 4:20
어제 못했어
러닝 대신 로잉 2km 했고 무릎이 좀 뻐근했어
이번 주 어때?
```

The agent reads that, calls the CLI, and reports what was stored.

**CLI** — `bin/hyrox <command>`; `hyrox help` lists the whole surface. Nothing puts `hyrox`
on PATH, so anything invoking it non-interactively — the OpenClaw agent above all — must use
the absolute path to `bin/hyrox`. Every command string the CLI *prints* for someone to run is
absolute for that reason; `hyrox …` below is shorthand for a human reading this file.

```bash
hyrox today                                  # today's session and both athletes' logs
hyrox day 2026-09-09 / hyrox week / hyrox stats --who a
hyrox log --who a --done --weight 82.4 --pace 4:20   # one athlete, one day
hyrox brief morning|nudge|weekly             # the scheduled messages, as text

hyrox doctor [--telegram <id>] [--json]      # wiring self-check; exits 1/2 when something is wrong

hyrox setup [--who a] [--json]               # which 목표 값 are still empty (onboarding)
hyrox goal show [--json]                     # every target weight, and which phase is which
hyrox goal --who a --weight 82               # 시즌 전체 목표 (goal tab B6/C6)
hyrox goal --who a --phase 2 --weight 81     # 단계별 목표 (phase tab D/E)
hyrox goal --who a --date 2026-09-09 --weight 83   # 그 날 목표 (log tab D/F)
```

`setup` is the onboarding checklist and is finished at two cells — one season goal weight per
athlete. The eight phase targets are offered once and are optional; the per-day targets are
counted, never demanded. When a tab cannot be written to, `setup` says so and *omits* the
commands rather than printing ones the sheet would refuse.

`--phase` and `--date` name two different cells, so they cannot be combined. Neither can any
flag be repeated: `--who a --who b` is refused outright, because a plural sentence
("둘 다 82kg으로 하자") is two writes or none, never one athlete's number under the other's name.

### When nothing is happening — `hyrox doctor`

Every wiring break this project has actually suffered was **silent**. The group was missing from
OpenClaw's `groups` map and all traffic was dropped as `not-allowed`; a mention gate discarded
photos *before* downloading them; the bot was removed from the group and every send 403'd;
Telegram privacy mode was toggled on a group the bot had already joined. In all four cases the
sheet just stopped filling up, and nobody knew until a human went log-diving days later.

```bash
hyrox doctor                       # 13 checks, one line each
hyrox doctor --telegram 514675395  # also: does this exact sender id resolve, and to whom
hyrox doctor --json                # {ok, exitCode, verdict, checks:[…], unverifiable:[…]}
hyrox doctor --write-probe         # additionally prove Editor rights (opt-in; see below)
```

| Check | FAIL means |
|---|---|
| `node.version` | the wrapper picked a Node that cannot strip types — every command dies on syntax |
| `env.file` | `--env-file-if-exists` found no `.env.local`; it fails silently by design |
| `env.identity` | a `TELEGRAM_USER_*` is missing, non-numeric, or the same for both — one athlete can never log, or both land in one column |
| `env.names` | (WARN) `--who <이름>` will not resolve and every message says "선수 A" |
| `env.credentials` | no usable Google credential. Prints `client_email` only — never key material |
| `season.window` | today is outside 2026-08-01 … 2026-11-13, so `today`/`log` refuse |
| `clock.timezone` | the CLI's "today" disagrees with Asia/Seoul's |
| `identity.roundtrip` | the id the agent is actually holding maps to nobody |
| `sheet.read` | the sheet is unreachable; a 403 carries the "share with this account" text |
| `sheet.anchors` | a row or column was inserted — writes to that tab are refused |
| `sheet.tabs` | the goal or phase tab could not be read, so `goal` writes are refused |
| `sheet.write` | SKIP unless `--write-probe`. Reads succeed for anyone with view access, so nothing else can distinguish Viewer from Editor |
| `inbound.freshness` | an athlete's rows have gone quiet — **measured per athlete** |

`inbound.freshness` is the only one that can see an inbound break at all, and it can only see it
indirectly: a CLI that is never invoked cannot report that it was never invoked. It is deliberately
**per athlete** — every break so far has been one-sided, so a combined "last activity" counter
would have read green for the whole of the incident this check was written for. 3–6 days is a WARN,
7+ is a FAIL, and a rest week trips it too; the fix line says "suspect the inbound path", not
"the inbound path is broken".

The report always ends with what it *cannot* check, so a green verdict never reads as "the bot is
alive": the Telegram inbound path, `openclaw channels status --probe`, the `not-allowed` /
`no-mention` drop reasons in the gateway log, and a stored `activation:mention` on the group
session (which outranks the group config).

`doctor` never throws — an exception inside a check becomes that check's FAIL line, because a
doctor that reports nothing is the worst possible outcome. It never writes without `--write-probe`,
and the probe writes a cell's own current text back to it byte for byte, skipping the cell entirely
if it holds a formula. Exit codes reuse the existing convention exactly: `1` local and fixable,
`2` the sheet needs a human, `2` when both. The report goes to **stdout even on a non-zero exit**,
because for this one command a non-zero exit is the successful outcome.

Run it on demand when a command returns 2 or someone says the bot is not responding, and from the
scheduled morning job — cron wakes that job, so it survives the very inbound failure it reports on.

### Why the CLI refuses instead of guessing

The first version of this repo parsed Korean training messages itself. Four rounds of adversarial
review killed that approach: **44 confirmed defects, and every fix bought one case at the price of
an adjacent one.** The pattern that correctly read `슬레드 152kg` as a load broke
`완료 82.4kg 슬레드 152kg`; the rule that stopped a memo hijacking the day broke
`나 어제 운동 다 했어`. The defects were not bugs in the patterns — they *were* the patterns.

A model handles that free text far better than a grammar can, so the parser is gone and OpenClaw
does the reading. What survives is the lesson about where the danger is: the failure mode is not
a garbled message, it is a *plausible* one. `슬레드 152kg 밀었어` yields a body weight that is
perfectly reasonable in isolation.

So the CLI is deliberately literal, and it refuses on three levels:

| Check | Catches |
|---|---|
| Exact identity match (`--telegram` / `--who`) | a log filed against the wrong athlete — silent and permanent once written |
| No flag may be given twice | one command trying to cover both athletes, which used to resolve to whichever came last |
| Range checks per field | pace with 75 seconds, RPE 11, a duration of 900 minutes |
| Weight vs. this athlete's last record (>10kg → refuse) | equipment loads read as body weight, which no range check can see |
| On a first record, weight vs. that athlete's own declared goal weight | the same thing on someone with no history, where a wrong first value becomes the baseline that then refuses the correct one |
| Valueless flags reject a value (`--done false`, `--done 109`) | an inverted completion, and a number silently eaten as a flag's value |
| Row/column anchors on every read | a sheet edit that would file every later log against the wrong date |
| Empty-range checks before a target write | a tab or header row that cannot be read, where the write lands somewhere unknown |
| Authored text in a target cell | a hand-written note overwritten by a bare number, reported as "미입력 →" |

An out-of-range value never clears a stored measurement, and a refusal writes nothing at all —
not even the valid parts of the same command. `--force` overrides the weight check when the
change is real, and the authored-text check when the note is disposable — on all three target
paths, not merely on two of them.

---

## Degradation

| Missing / wrong | Effect |
|---|---|
| OpenClaw down / machine asleep | No pushes and no chat. The PWA and the CLI are unaffected. |
| `TELEGRAM_USER_*` unset | `--telegram` refuses that id rather than guessing; `--who` still works. |
| Sheets API error on write | The write is refused and surfaced (exit 2); nothing is partially applied. |
| Sheets API error on the confirmation re-read | Reported as saved-but-unconfirmed; the cells were written. |
| A row **or column** inserted/deleted in the log tab | Every write is refused, naming the offending cell. Three anchors are checked on every read: column A (date) catches a row edit — an inserted row arrives blank, so blank counts as a mismatch; column C (weekday, compared by the day it denotes so 토/토요일/Sat all pass) catches a column edit left of the data; and the header row A3:T4 catches a column edit *inside* the data, which the first two cannot see because they sit to the left of every cell the app writes. |
| A typo in a numeric field | In the app: refused with a 400 and named in the UI. In chat: the CLI refuses with exit 1 and the agent relays why. |
| The Telegram inbound path breaks (group dropped, mention gate, bot kicked, privacy mode) | **Nothing here can see it** — a CLI that is never invoked cannot report that it was never invoked. The only local symptom is `hyrox doctor`'s `inbound.freshness` going quiet for one athlete; everything else in the report stays green. |

---

## How this was reviewed

Six rounds of adversarial multi-agent review ran against this code. Each round: independent
agents search along different lenses, then two or three skeptics try to *refute* every finding
by executing it — a finding only counts if nobody can make it go away.

| Round | Raised | Confirmed | What it found |
|---|---:|---:|---|
| 1 | 71 | 20 | correctness across the whole surface; silent data loss, auth, HTML injection |
| 2 | 25 | 8 | the heuristic parser mis-reading loads, clock times, rest intervals |
| 3 | 20 | 8 | the same class again, in new shapes — the signal to change approach |
| 4 | 20 | 8 | more of the same, **plus two regressions the round-3 fixes introduced** |
| 5 | 19 | 7 | first round after the grammar rewrite — all bounded, all local |
| 6 | 14 | 8 | edge cases in the grammar and the structural anchors |

**59 confirmed defects, all fixed.** The loop did not converge to zero, and the interesting part
is *why*: rounds 2–4 kept finding the same class of defect because the heuristic parser could not
be fixed, only rebalanced. Round 4 is the evidence — two of its findings were regressions caused
by round 3's fixes.

The parser those rounds hardened has since been deleted, which is the right outcome rather than a
waste: the reason the CLI now checks identity exactly, bounds every field, and compares weight
against history is that those rounds showed exactly where a misread sentence does damage.

## Development

```bash
npm test        # no network, no credentials
npm run typecheck
npm run build
```

The suite grows with the surface, so no count is quoted here — a hard-coded figure only ever
goes stale, and a stale one makes a useless baseline for judging whether coverage was added or
a glob was polluted.

The Sheets client is an interface, so the whole stack — the CLI, storage, brief building — runs in
tests against an in-memory sheet that reproduces the real API's quirks (A1 range semantics,
truncated trailing cells and rows).

`tests/eval.test.ts` plays the entire 15-week season through the CLI: morning brief, both athletes
logging, evening nudge, Sunday review — 105 days, ~200 writes. An independent expectation model is
diffed against the resulting sheet. `tests/cli.test.ts` covers the contract OpenClaw depends on,
and is mostly about what the CLI *refuses*.

### Layout

```
bin/hyrox      wrapper: picks a Node that can run TypeScript, loads .env.local
scripts/
  hyrox.ts     CLI entry point (exit codes only)
  init-sheet.mjs  one-time header setup + permission diagnosis
src/lib/
  cli.ts       the command surface OpenClaw drives; all validation lives here
  doctor.ts    self-diagnosis: env, identity, credentials, sheet anchors, per-player silence
  briefs.ts    morning / nudge / weekly, as text — no delivery
  messages.ts  every string the agent can emit (pure, plain text)
  season.ts    date ↔ row arithmetic, KST today, week/phase boundaries
  cells.ts     cell text ↔ typed values (round-trip guaranteed)
  diet.ts      the 식단 tab: four meals a day per athlete, as text
  grid.ts      grid ↔ records; minimal cell-update planning
  stats.ts     completion, streaks, weekly aggregates
  phases.ts    Phase 1-4 targets, and that tab's row/header anchors
  goals.ts     the goal tab's section 1, and the onboarding report over all three tiers
  config.ts    player names and telegram ids, read from the environment
  sheets.ts    Google Sheets REST + auth
  store.ts     read-before-write orchestration
  auth.ts      per-player URL keys for the PWA
```

Exit codes: `0` fine, `1` bad input (fixable — re-read the message), `2` the sheet said no
(retrying will not help).
