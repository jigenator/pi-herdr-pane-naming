# pi-herdr-pane-naming

A Pi extension that names the **actual Herdr pane label**, without asking the
main model to do naming housekeeping.

```text
User message starts being processed, or assistant activity changes
  → Jev: does the current name still fit?
  → if necessary, your selected model: write a short title
  → extension: rename only its inherited Herdr pane
```

**Implemented; off until you enable it.** Enabling once saves the default and
title model for new interactive Pi panes. Offline checks and a small synthetic
live smoke test pass; broader naming-quality evaluation is still needed.
This is not an agent-callable rename tool. It does not route work, change Pi's
main model, or modify Herdr's managed status extension.

## Requirements

- Pi `0.86.1` or a compatible version; Herdr CLI/server `0.9.0` or compatible.
- Node `22.18+` for the offline checks.
- A Cloudflare Workers AI credential with access to `typesafe/jev`, and its
  account ID. This version uses the Cloudflare contract, not a direct TypeSafe key.
- A title model already configured in Pi. Google models use Pi's existing Google
  credentials. `google/gemini-3.5-flash-lite` was live-tested; it is not an automatic
  default. No main-model credential is forwarded to Cloudflare.

No new runtime dependencies or build step.

## Try locally, without installing

From this checkout:

```sh
pi -e ./index.ts
```

Loading it does **not** call a model or rename anything. No provider/model is
chosen implicitly. To configure a later, explicitly enabled trial:

```sh
export CLOUDFLARE_JEV_API_CREDENTIALS_FILE="$HOME/.config/jev/jev_cloudflare_ai_gateway_credentials.json"

pi -e ./index.ts --pane-naming-model google/YOUR_MODEL_ID
```

This is the only Jev configuration variable. Set it to an absolute path in the
parent shell before starting Pi. Other Jev integrations can read the same file.
The file is JSON, not a shell `.env` file:

```json
{
  "accountId": "YOUR_CLOUDFLARE_ACCOUNT_ID",
  "apiToken": "YOUR_CLOUDFLARE_API_TOKEN"
}
```

Optional `gatewayId` selects an existing gateway; omit it to use the account's
default. `apiToken` is a Cloudflare token, not a direct TypeSafe key. The file is
read for each Jev request, so token/account changes do not require a reload.
Missing or invalid credentials skip naming without sending a request. Separate
account, token, token-file, and gateway environment variables are no longer read.

Keep the file outside this repository with owner-only permissions (`chmod 600`).
Never paste a real token into a command recorded in a transcript. Merely setting
the path or loading this extension does not make a model request.

In that session:

- `/pane-naming status` — this pane's active settings, saved defaults, and call counts.
- `/pane-naming on` — enable naming here and save it as the default for new panes.
- `/pane-naming off` — cancel naming here and turn off the default for new panes,
  leaving the current label alone.
- `/pane-naming adopt` — confirm replacing this pane's existing label, then enable
  naming here and save the same default for new panes.
- `/pane-naming cooldown 30` — set the assistant-check interval in seconds
  (whole number, **1–3,600**; default **30**).
- `/pane-naming limit 40` — set the shared Jev-check cap per session/pane
  (whole number, **1–1,000**; default **40**).
- `/pane-naming model google/gemini-3.5-flash-lite` — choose a title model available
  in Pi, as `provider/model-id`. Configure its credentials in Pi first.

The three settings commands **apply immediately here and save defaults for future
panes**, using the same owner-only preferences file. No reload is needed after
changing a value. They do not enable or adopt a pane, reset attempt counts, change
Pi's main model, or change another running pane's settings. Invalid values and
failed saves leave both the current settings and the saved file unchanged.

Changing the cooldown reschedules any already-queued activity using the last
actual Jev attempt; shortening it can make that queued check run immediately.
Setting a title model cancels pending/in-flight naming work but keeps the current
human-request scope, so future assistant activity can use the new model. Neither
command backfills history or creates a synthetic naming request.

Lowering the limit to an already-used count pauses naming immediately. A larger
limit does not turn an off/paused pane back on; use `/pane-naming on` explicitly
when ready to resume. Used attempts still count, even after a limit change or
reload. Higher limits and shorter cooldowns can increase paid usage.

A successful `on` or confirmed `adopt` saves the enabled setting and selected
title model in `~/.pi/agent/pane-naming.json` (`PI_CODING_AGENT_DIR` is respected).
No credentials are stored there. **New unnamed interactive Pi panes then start
naming automatically**, without repeating flags, `on`, or `adopt`. Each instance
still controls only its own pane. Existing named panes remain protected.

Other already-running panes retain their active settings until `/reload`, restart,
or an explicit `on`/`adopt` in that pane. Reading `status` does not silently adopt
settings saved elsewhere. At startup/reload, `--pane-naming` enables this session,
and `--pane-naming-model provider/model-id` overrides the saved model. A later
`model` command takes precedence in that running instance (including subsequent
`off`/`on`), and also saves its choice for future panes without that flag. Startup
flags alone do not change the saved defaults. Only enable naming once the
configuration and data-sharing policy are acceptable.

### Avoid competing naming mechanisms

Do **not** enable this in a session where the main agent is still instructed to
rename panes. For an isolated trial, start a separate Pi session in your own pane
with context-file loading disabled, rather than deleting the old instructions:

```sh
pi --no-context-files -e ./index.ts \
  --pane-naming-model google/YOUR_MODEL_ID
```

This disables **all** AGENTS/CLAUDE context files for that trial. Use synthetic
naming requests, not ordinary project work that needs those instructions. Adopt
the existing label explicitly if necessary, then turn naming on. Obtain approval
before making live inference calls. Do not target a different pane.

Only after the replacement has been verified should the old pane-naming section
be removed and the extension installed globally. This repository does neither.
A future installation can use:

```sh
pi install /absolute/path/to/pi-herdr-pane-naming
# After this implementation is published:
pi install git:github.com/jigenator/pi-herdr-pane-naming
```

Use `/reload` or restart after installation. Naming uses your saved global default;
without one, it remains off.

## Triggering and safeguards

- Requires `HERDR_ENV=1`, an inherited `HERDR_PANE_ID`, `ctx.mode === "tui"`,
  and no `PI_SUBAGENT_CHILD=1`. RPC, print, JSON, and child sessions do nothing.
- Observes ordinary interactive text inputs, then waits for the corresponding
  user `message_start`. Queued steering/follow-ups are checked when delivered,
  **not** when queued. Inputs handled elsewhere and never delivered make no call.
  Input provenance is tracked locally even while naming is off; enabling or
  re-enabling mid-task preserves that scope for future assistant activity, but
  does not replay the user request or make a model call by itself.
- Eligible user delivery starts a background check immediately. During that work,
  finalized assistant `message_end` events also trigger checks: visible progress
  text and requested tool names can reveal a shift from research to debugging,
  implementation, or another phase without a new user prompt.
- Assistant checks wait until the configured cooldown after the last Jev check
  (**30 seconds by default**). During that cooldown, only the latest snapshot is kept; identical consecutive snapshots
  make no additional call. Tool-only messages retain the latest visible progress
  text from the same user request. Tool arguments, results, streaming chunks,
  thinking-only messages, and incomplete/error responses do not trigger checks.
  No polling or separate check for each tool in a batch.
- Jev returns `keep`, `update`, `new_task`, or `uncertain`. Only `update` and
  `new_task` invoke the title model; `keep` and `uncertain` leave the name alone.
  The extension follows Jev's validated choice without an extra confidence cutoff.
- Titles are validated plain text. Renames use argument arrays, not a shell;
  model output can never choose the executable or target pane.
- Uses `herdr pane get/rename`, not terminal titles or Pi session names. A changed
  terminal identity or unexpected pane ID stops naming; it never falls back to
  whichever pane is focused. A pane moved between workspaces may therefore
  need a fresh session rather than using a different discovered ID.
- New delivered messages, changed assistant snapshots, navigation, shutdown,
  disabling, and agent cancellation invalidate pending model results. Superseded
  activity timers are cleared. Writes are serialized and rechecked after
  asynchronous reads. Shutdown waits only for an already-issued, time-bounded
  CLI write.
- Identical names cause no rename. Failures never handle/block user input, inject
  prompts, or ask the main model to recover. No automatic request retry.

### Names you set yourself

An existing label is protected unless it matches this extension's saved ownership
for the **same session, pane, and terminal**, or you explicitly adopt it. Later
outside label changes pause automation, including while a model call is running.
A new/forked session cannot assume ownership of an old session's label.

Herdr does not expose who set a label or offer an atomic "rename only if still
unchanged" operation. Therefore an identical manual re-assignment is not
observable, and a manual rename racing an already-issued write can be overwritten.
This protection is conservative, **not race-free**. Likewise, an already-issued
CLI write cannot be recalled on cancellation. The next session waits for it to
settle before taking over.

The extension does not use display-metadata titles as a workaround: Herdr 0.9
renders those ahead of manual labels. Other metadata-title producers can mask
this extension's actual label changes.

### PR numbers

The title model may select only explicit `PR #123` references or GitHub pull-request
URLs from the current user request, plus already-tracked PRs for a continuation.
Assistant text and tool names cannot authorize additional PR numbers.
Code adds the `PR #123 ·` prefix and removes redundant references to those same
selected PRs from the model's title. Unknown PR references are rejected. A new task
cannot inherit old PR numbers. Selection of **which mentioned PR is relevant**
remains a model judgment, not a deterministic guarantee or GitHub existence check.

A successful, direct, single-line `gh pr create ...` tool call whose entire text
result is one GitHub PR URL adds the confirmed number without itself calling a
model. An already-displayed title can receive this prefix during an activity
cooldown; assistant activity may separately schedule a naming check.
The tool result must belong to the still-current task. Shell scripts, pipelines,
wrappers, alternate hosts, JSON output, and other PR-creation tools are deliberately
not parsed. Those require an explicit user PR reference for this version.
Up to four PR numbers are supported; they are replaced/dropped on subsequent
classified task changes.

## Data sharing and cost bounds

Both services can receive:

- the first 2,000 characters of the delivered user request;
- up to 2,000 characters from the previous named task's user request;
- the current pane name (normally at most 80 characters);
- on user-triggered checks, up to 600 characters of the latest assistant's visible
  text, for replies like "yes, do that";
- on activity-triggered checks instead, up to 600 characters of the latest visible
  assistant progress text within that request and up to eight distinct requested
  tool names (at most 64 characters each). Names alone do not prove a tool ran or
  succeeded;
- the title model additionally receives the allowed PR numbers.

No full transcript, system prompt, thinking, images, tool arguments, file reads,
commands, or general tool output is forwarded directly. These small excerpts **can still contain sensitive data**;
there is no general secret-redaction guarantee. The generated label is visible
in Herdr and is not suitable for sensitive content.

- The configured limit bounds Jev checks and title requests per session/pane
  (**40 of each by default**), counting attempts before they are made. User and
  assistant triggers share this budget; assistant activity can exhaust it sooner.
  `/pane-naming limit` changes the cap, not the number already used. Counts survive
  reload and tree navigation.
- Each model request has an **8-second deadline**; each Herdr command, **1.5 seconds**.
- Title responses are capped at **160 output tokens**, with thinking disabled
  for the Google adapter. Jev responses are capped at **16 KiB**.
- Cloudflare requests disable gateway cache/retries and request gateway logging
  off. Provider-side retention policies still apply. No provider failover.
- Cancelled/failed requests may still be billed. Counts are attempt caps, not a
  dollar budget. `/pane-naming status` reports attempts; these background calls
  are **not included in Pi's main-session token/cost totals**.
- Counts, ownership identifiers, generated titles/PRs, sanitized failure metadata,
  and reload handoffs (request-entry reference and last-check time, not excerpts)
  are saved as Pi custom entries (outside model context). Credentials,
  request excerpts, raw provider errors, and response bodies are not logged.

### Diagnosing failures

An intentional `keep` or `uncertain` decision does not produce a failure warning.
A failed attempt reports its stage (Jev, title model, or local preparation),
elapsed time, and a safe reason: HTTP status, deadline, validation failure, or a
known network error code where available. Probability-sum failures include the
sum and absolute deviation from 1, computed only after all four probabilities
pass numeric/range validation. These numbers retain their JavaScript precision
to expose rounding effects; the `0.001` tolerance is unchanged. Individual
probabilities and raw response bodies are not retained. Unknown error details
stay withheld.
The same metadata and attempt counts are saved in a `herdr-pane-naming-failure`
custom entry, so the evidence survives reload without entering model context.
Cancelled or superseded work is not logged as a failure. No automatic retries
are added. Earlier generic warnings did not save their underlying cause and
cannot be diagnosed retrospectively from the naming records alone.

## Current coverage limits

This version skips images, slash/skill/template invocations, RPC/extension inputs,
text changed by a later input-transform hook, and assistant activity following
those excluded inputs. Injected custom messages end the eligible activity scope.
After the agent settles, a pending snapshot may finish unless another run starts;
a later autonomous run needs a new eligible user delivery. Reload preserves an
observed human task only while that same task is still running in the same
session/pane/terminal. The old instance hands off the request's entry reference;
the new instance recovers the bounded request/progress from that branch and
preserves the cooldown. Only future assistant activity triggers a check—reload
itself does not replay requests or retry cancelled work.

Cold starts, completed tasks, and pre-upgrade instances without a handoff still
need a new eligible user delivery. Pi's saved user messages do not record input
origin, so this extension cannot safely infer human provenance from arbitrary
old history. The first reload that installs this fix cannot recover scope from
an older version; subsequent observed tasks can survive later reloads.

Activity naming uses bounded progress text and tool names, not hidden reasoning or
command contents. A silent switch between two `bash` commands may therefore be
indistinguishable. Routine tool use and completed-work recaps should not cause
renames; deciding whether a phase change deserves a new label is still Jev's job.
The new assistant-triggered path has offline regression coverage, not a live
quality evaluation.

Jev's naming-only rubric is separate from task routing/difficulty classification.
It reuses the existing Cloudflare request/response pattern, but there is no shared
router event/API integration. Task relevance, title quality, and PR relevance
still need broader labeled evaluation before a general rollout.

## Checks

```sh
npm test
```

Uses Node's test runner; no installation, credentials, live model requests, or
live Herdr writes. Tests mock the CLI and models, including manual-name protection,
queue delivery, assistant progress and tool-only activity, cooldown/coalescing,
headless/child gates, stale results, failures, PR updates, privacy bounds, request
validation, shared/reload budgets, mid-task enablement and reload scope,
command settings, pending-work cancellation, atomic-save failures,
and defaults across new panes without changing other active
panes. Preference-file checks use isolated temporary directories, never your live settings.

Optional check against an installed Pi loader, also without live calls:

```sh
PI_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" \
  node test/pi-load.mjs
```

### Limited live smoke test (2026-09-20)

Six synthetic Jev requests produced the intended rename-or-preserve action under
the initial policy. That policy converted two low-confidence continuations to
`uncertain`. The extra confidence cutoff has since been removed: a later approved
diagnostic returned `new_task` with confidence `0.75`, but the old `0.8` cutoff
blocked title generation. That case now has an offline regression check.
These small samples are not an accuracy benchmark.

Google Gemini 2.5 Flash-Lite rejected two attempts as retired for new users.
Four subsequent, explicitly approved Gemini 3.5 Flash-Lite requests exposed two
format variations: fenced JSON and PR numbers repeated inside the title. Both
now have offline regression checks. The last fresh request passed the full title
parser, correctly switching to `PR #234 · Review`; captured earlier synthetic
responses also pass the corrected parser. No further requests were made.

The extension was loaded with the installed Pi loader, and its CLI argument form
was checked on the caller's own pane, leaving the original label restored. One
subsequent interactive Jev → title model → own-pane rename was also confirmed.
Broader interactive validation and naming-quality evaluation remain outstanding.

API behavior was checked against installed Pi 0.86.1 documentation/types and the
Herdr 0.9.0 CLI/schema. The Cloudflare transport follows its `Completed` response
envelope; changing providers requires a separately verified transport, not an
arbitrary credential-bearing endpoint.
