# pi-herdr-pane-naming

A Pi extension that keeps the **actual Herdr pane label** describing what the
session is working on, without asking the main model to do naming housekeeping.

```text
User message delivered, or assistant activity changes
  → Jev (through pi-typesafe): does the current name still fit?
  → if not, a small title model writes a short title
  → extension: rename this process's own Herdr pane
```

**On by default.** Every main interactive Pi session in a Herdr pane names its
pane, including new, resumed, forked and reloaded sessions, `/goal` runs, skill
and template prompts, and messages sent by other extensions. Existing labels are
taken over. `/pane-naming off` is the only off switch, and it applies to new
panes too until `/pane-naming on`.

This is not an agent-callable rename tool. It does not route work, change Pi's
main model, or modify Herdr's managed status extension.

## Requirements

- Pi `1.0.4` or compatible; Herdr CLI/server `0.9.3` or compatible.
- Node `22.19+` (required by `pi-typesafe`).
- A TypeSafe key for Jev: run `/typesafe login` once (from the
  [`pi-typesafe`](https://github.com/DevMortimer/pi-typesafe) package), or set
  `TYPESAFE_API_KEY`. The key is read for every check, so logging in later takes
  effect without a reload.
- A title model Pi can use. Without a saved choice, naming uses
  `google/gemini-3.5-flash-lite` when Pi has it configured, otherwise the
  session's current model.

The only runtime dependency is `pi-typesafe`, which brings `@typesafe-ai/sdk`.

## Install

```sh
pi install git:github.com/jigenator/pi-herdr-pane-naming
```

Pi installs dependencies for npm and git sources. **A local checkout** (for
example `pi install /absolute/path/to/pi-herdr-pane-naming`, or a relative path
in `settings.json`) is loaded as-is, so run `npm install` in the checkout first
and again whenever `package.json` changes. Then `/reload` or restart Pi.

To try a checkout without installing it:

```sh
npm install
pi -e ./index.ts
```

Do not enable this in a session where the main agent is also told to rename
panes; the two will fight over the label.

## Commands

- `/pane-naming status` — on/off here, the new-pane default, this session's Jev
  check and title request counts, the cooldown, the title model in use (marked
  `default` or `fallback`), and the TypeSafe key status.
- `/pane-naming on` — enable naming here and save "on" for new panes.
- `/pane-naming off` — stop naming here and save "off" for new panes. The current
  label is left alone. Other running panes keep naming until they restart or reload.
- `/pane-naming cooldown 30` — seconds between assistant-activity checks
  (whole number, **1–3,600**; default **30**).
- `/pane-naming model google/gemini-3.5-flash-lite` — the title model, as
  `provider/model-id`; it must already be available in Pi.

`cooldown` and `model` apply immediately in this pane and are saved for future
panes. Other running panes keep their settings until restart or `/reload`.
Changing the model cancels pending work started with the previous model. A
shorter cooldown can run a queued activity check immediately.

Settings live in `~/.pi/agent/pane-naming.json` (`PI_CODING_AGENT_DIR` is
respected), written atomically with owner-only permissions. No credentials are
stored there. A missing file means the defaults (on). An unreadable or invalid
file at startup produces a warning and the defaults; commands then refuse to
overwrite it until you fix or delete it (`off` still stops the current pane).

Startup flags: `--pane-naming-model provider/model-id` overrides the saved model
for that session; `--pane-naming` turns naming on for that session even when the
saved default is off. Neither changes the saved file.

## When it runs

- Requires `HERDR_ENV=1`, an inherited `HERDR_PANE_ID`, `ctx.mode === "tui"`,
  and no `PI_SUBAGENT_CHILD=1`. RPC, print, JSON, and subagent child sessions do
  nothing, so children never fight their parent over the shared pane.
- **Every delivered user message** with text starts a background check when it
  is delivered (`message_start`). Queued steering/follow-ups are checked when
  delivered, not when queued. Images are ignored; only text blocks are used.
- **Assistant activity** also triggers checks: finalized assistant
  `message_end` events with visible progress text or requested tool names can
  reveal a shift from research to debugging or implementation without a new
  prompt. Checks are anchored on the latest user message on the current branch,
  which is recomputed at every session start (startup, reload, resume, new, fork)
  and after `/tree` navigation, so naming continues after a reload or resume
  without another prompt. Custom and extension messages do not end that scope.
- Assistant checks wait until the cooldown after the last Jev check. During the
  cooldown only the latest snapshot is kept; identical consecutive snapshots make
  no call. Tool-only messages reuse the latest visible progress text. Tool
  arguments, results, streaming chunks, thinking, and aborted/error responses do
  not trigger checks. No polling and no per-tool requests.
- Jev returns `keep`, `update`, `new_task`, or `uncertain`. Only `update` and
  `new_task` call the title model; `keep` and `uncertain` leave the name alone.

## Labels you set yourself

Automation owns the label. An existing label (from an earlier session or typed by
hand) is replaced at the next `update`/`new_task` decision, and renaming the pane
by hand does not pause naming. Use `/pane-naming off` to keep a label of your own.
Herdr has no conditional rename, so a manual rename racing an already-issued write
is simply overwritten.

## Safeguards

- Renames use `herdr pane get/rename` with argument arrays, never a shell. Model
  output can never choose the executable or the target pane; the target is always
  the inherited `HERDR_PANE_ID`. The first terminal seen for that pane is
  remembered; if the pane ID later reports a different terminal, every rename from
  that process is refused (and reported) rather than touching someone else's pane.
- Titles are validated plain text (≤55 characters, no control or invisible
  characters, no leading hyphen, no stray PR references).
- A new delivered message, a changed assistant snapshot, navigation, shutdown,
  `off`, a model change, and agent cancellation invalidate pending model results.
  Writes are serialized and rechecked after asynchronous reads. Shutdown waits
  only for an already-issued, time-bounded CLI write.
- Identical names cause no rename. Failures never block user input, inject
  prompts, or ask the main model to recover.

## PR numbers

The title model may select only PRs from an allowed list: explicit `PR #123` or
`PR 123` references and GitHub pull-request URLs in the current user request,
plus, for an `update`, the PRs already in the pane's `PR #… ·` prefix. A
`new_task` never inherits old PRs. Code adds the `PR #123 ·` prefix and removes
redundant references to the same PRs from the title. Choosing which mentioned PR
is relevant remains a model judgment, not a GitHub existence check.

A successful, direct, single-line `gh pr create …` bash call whose entire text
result is one GitHub PR URL adds that PR to the current title without a model
call. Pipelines, wrappers, alternate hosts, JSON output, and other PR tools are
deliberately not parsed. Up to four PRs are shown.

## Data sharing and cost

Jev requests go to `api.typesafe.ai` through `pi-typesafe`; title requests go to
the title model's provider through Pi. Both can receive:

- the first 2,000 characters of the latest user request;
- up to 2,000 characters of the previous named task's request;
- the current pane label (at most 80 characters);
- on user-triggered checks, up to 600 characters of the latest assistant visible text;
- on activity-triggered checks, up to 600 characters of the latest assistant
  progress text and up to eight requested tool names (≤64 characters each);
- the title model also receives the allowed PR numbers.

No full transcript, system prompt, thinking, images, tool arguments, file
contents, or tool output is forwarded. These excerpts **can still contain
sensitive data**; there is no general redaction. The label is visible in Herdr.

Cost bounds:

- No per-session check cap. Spend is bounded by the cooldown, by the fact that
  only `update`/`new_task` call the title model, and by `pi-typesafe`'s optional
  daily caps, shared with every other pi-typesafe user on the machine:
  `PI_TYPESAFE_MAX_REQUESTS_PER_DAY`, `PI_TYPESAFE_MAX_INPUT_TOKENS_PER_DAY`,
  `PI_TYPESAFE_MAX_USD_PER_DAY`. A reached cap is reported as a Jev failure.
- Naming checks appear in `/typesafe status` (today's requests, tokens and
  estimated cost). They are **not** included in Pi's main-session token/cost totals.
- Each model request has an **8-second deadline**; each Herdr command **1.5 seconds**.
  No automatic retries. Cancelled or failed requests may still be billed.
- Title responses are capped at **160 output tokens** with thinking disabled for
  Pi's Google adapter.

## Diagnosing failures

Failures never turn naming off. A failed attempt shows one warning naming its
stage (`Title model selection`, `Herdr read`, `Jev`, `Title model`, or
`Herdr rename`), the elapsed time, and a safe reason: pi-typesafe's own message
(for example `No API key. Run /typesafe login in Pi, or set TYPESAFE_API_KEY…`
or an HTTP status with advice), a deadline, a title validation rule, or a known
network error code. The same warning is not repeated until a check succeeds, so a
missing key cannot flood the screen; the next activity simply tries again.

Each failure is also saved as a `herdr-pane-naming-failure` custom entry
(`paneId`, session check/title counts, stage, reason, elapsed time) that survives
reload without entering model context. Request text, rejected titles, raw errors,
response bodies and credentials are never logged. Cancelled or superseded work is
not a failure. A startup warning also appears when no title model is usable or
`pi-typesafe` reports the key as missing or rejected; naming stays on and picks
up a later `/typesafe login` or `/pane-naming model` without re-enabling.

## Upgrading from 0.1

- `CLOUDFLARE_JEV_API_CREDENTIALS_FILE` is no longer read; Jev uses the
  pi-typesafe key. You can remove the variable and the credentials file.
- Naming is on unless `/pane-naming off` saved it off. A saved `"enabled": true`
  keeps working.
- `/pane-naming adopt` and `/pane-naming limit` are gone. A saved `checkLimit`
  is ignored and dropped the next time settings are saved.
- Earlier per-session ownership/check-count entries in old sessions are ignored.

## Checks

```sh
npm install
npm test
```

Node's test runner with mocked Herdr, models and TypeSafe transport: no network,
credentials, live model calls, or live Herdr writes. Preference-file checks use
temporary directories, never your live settings.

Optional check against an installed Pi loader, also without live calls (uses a
temporary `PI_CODING_AGENT_DIR`, so your real pi-typesafe key is not read):

```sh
PI_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" \
  node test/pi-load.mjs
```
