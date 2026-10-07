import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authState, describeAuth } from "pi-typesafe";
import {
  abortable, classify, DEADLINE_MS, describeFailure, explicitPRs, failure, generateTitle, paneLabel, parseLabel, resolveTitleModel,
  type NamingInput, type Title,
} from "./models.ts";

const STATE = "herdr-pane-naming";
const CLI_TIMEOUT = 1_500;
const DEFAULT_COOLDOWN_SECONDS = 30;
const USAGE = "Usage: /pane-naming on | off | status | cooldown <seconds: 1–3600> | model <provider/model-id>";
type Pane = { pane_id: string; terminal_id: string; label?: string };
// Older versions also saved checkLimit; it is accepted and ignored.
type Preferences = { enabled?: boolean; titleModel?: string; cooldownSeconds?: number };
const validInteger = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;

function readPreferences(file: string): Preferences {
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Could not read pane-naming preferences.");
  }
  if (!value || typeof value !== "object" || (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
      (value.titleModel !== undefined && (typeof value.titleModel !== "string" || !/^[^/\s]+\/\S+$/.test(value.titleModel))) ||
      (value.cooldownSeconds !== undefined && !validInteger(value.cooldownSeconds, 3_600))) {
    throw new Error("Invalid pane-naming preferences.");
  }
  const { enabled, titleModel, cooldownSeconds } = value;
  return { enabled, titleModel, cooldownSeconds };
}

function savePreferences(file: string, value: Preferences) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    // Other Pi processes must see a complete old or new file, never a partial write.
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

export function eligible(env: NodeJS.ProcessEnv, ctx: Pick<ExtensionContext, "mode">): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && env.PI_SUBAGENT_CHILD !== "1" && ctx.mode === "tui";
}

// Text blocks only: images, thinking and tool content never leave Pi.
function text(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return;
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}

export function createdPR(command: unknown, output: string): string | undefined {
  // Deliberately not a shell parser: only a single, direct gh pr create is recognized.
  if (typeof command !== "string" || !/^gh\s+pr\s+create(?:\s|$)/.test(command.trim()) ||
      /[;&|<>`$\r\n]/.test(command) || /--(?:dry-run|web|help)\b/.test(command)) return;
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d{0,9})$/.exec(output.trim())?.[1];
}

export function register(pi: ExtensionAPI, dependencies: {
  preferencesFile: string;
  env?: NodeJS.ProcessEnv;
  classify?: (state: NamingInput, signal: AbortSignal) => ReturnType<typeof classify>;
  generateTitle?: typeof generateTitle;
  typesafeStatus?: () => { level: "ok" | "warning" | "error"; text: string };
}): void {
  const env = { ...(dependencies.env ?? process.env) };
  const paneId = env.HERDR_PANE_ID ?? ""; // Never accept a target from a model, command argument, or focused pane.
  const check = dependencies.classify ?? ((state, signal) => classify(state, signal));
  const titleModel = dependencies.generateTitle ?? generateTitle;
  const typesafeStatus = dependencies.typesafeStatus ?? (() => describeAuth(authState()));
  let ctx: ExtensionContext | undefined;
  let preferences: Preferences = {};
  let cooldownSeconds = DEFAULT_COOLDOWN_SECONDS;
  let modelOverride: string | undefined;
  let enabled = false;
  let epoch = 0;
  let controller: AbortController | undefined;
  let writes = Promise.resolve();
  let terminalId: string | undefined;
  let counts = { checks: 0, titles: 0 };
  let lastNotice: string | undefined;
  let previousTask = "";
  let activeRequest = "";
  let activeSignal: AbortSignal | undefined;
  let lastActivity = "";
  let activityText = "";
  let lastCheckAt = -Infinity;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingActivity: (() => void) | undefined;
  let desired: (Title & { epoch: number }) | undefined;
  let created = new Set<string>();
  const prCalls = new Map<string, number>();

  pi.registerFlag("pane-naming", { description: "Name this pane even if /pane-naming off saved the default as off", type: "boolean", default: false });
  pi.registerFlag("pane-naming-model", { description: "Title model: provider/model-id (overrides the saved model)", type: "string" });
  const selectedModel = () => modelOverride ?? (pi.getFlag("pane-naming-model") || preferences.titleModel);

  function cancel(keepTitle = false) {
    // Within one request, keep the latest title so a confirmed PR can still be added to it.
    const displayed = keepTitle ? desired : undefined;
    epoch++;
    controller?.abort();
    controller = undefined;
    clearTimeout(activityTimer);
    activityTimer = undefined;
    pendingActivity = undefined;
    lastActivity = "";
    desired = displayed ? { ...displayed, epoch } : undefined;
    created = new Set();
    prCalls.clear();
  }
  function notify(message: string, type: "info" | "warning" = "info") {
    try { ctx?.ui.notify(message, type); } catch { /* disposed session */ }
  }
  function current(version: number) { return enabled && !!ctx && version === epoch && !activeSignal?.aborted; }
  function scheduleActivity() {
    clearTimeout(activityTimer);
    activityTimer = undefined;
    if (!pendingActivity) return;
    const delay = Math.max(0, lastCheckAt + cooldownSeconds * 1_000 - performance.now());
    if (delay === 0) pendingActivity();
    else activityTimer = setTimeout(pendingActivity, delay).unref();
  }
  function fail(stage: string, error: unknown, elapsedMs: number) {
    const reason = describeFailure(error);
    try {
      pi.appendEntry(`${STATE}-failure`, { paneId, ...counts, stage, reason, elapsedMs });
    } catch { /* Diagnostics must not block work when session storage is unavailable. */ }
    // Naming stays on; repeat the same warning only after a success, so a broken key cannot flood the screen.
    const notice = `${stage}: ${reason}`;
    if (notice === lastNotice) return;
    lastNotice = notice;
    notify(`Pane naming failed at ${stage} (${elapsedMs} ms): ${reason} Naming stays on and tries again on the next activity.`, "warning");
  }

  // The latest user request on this branch anchors activity naming, including after reload, resume or tree navigation.
  function latestRequest(context: ExtensionContext) {
    const latest = context.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
    return latest?.type === "message" && latest.message.role === "user" ? text(latest.message.content)?.slice(0, 2_000) ?? "" : "";
  }

  async function pane(args: string[]): Promise<Pane> {
    const result = await pi.exec("herdr", ["pane", ...args], { timeout: CLI_TIMEOUT });
    if (result.code !== 0 || result.killed || result.stdout.length > 65_536) throw failure("Herdr CLI unavailable.");
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw failure("Herdr returned invalid JSON."); }
    const value = response.result?.pane;
    if (response.error || response.result?.type !== "pane_info" || value?.pane_id !== paneId ||
        typeof value.terminal_id !== "string" || !value.terminal_id ||
        (value.label != null && typeof value.label !== "string")) throw failure("Invalid Herdr response.");
    // HERDR_PANE_ID is inherited, so the first terminal seen is this process's. A different one is someone else's pane.
    terminalId ??= value.terminal_id;
    if (value.terminal_id !== terminalId) throw failure("Herdr pane now belongs to a different terminal.");
    return value;
  }

  function render(title: Title, version: number) {
    if (!current(version)) return;
    const candidate = { ...title, prs: [...new Set([...title.prs, ...created])].slice(0, 4), epoch: version };
    desired = candidate;
    // Serialize writes; stale work is checked again after every asynchronous read.
    writes = writes.then(async () => {
      if (!current(version) || desired !== candidate) return;
      const label = paneLabel(candidate);
      const before = await pane(["get", paneId]);
      if (!current(version) || desired !== candidate) return;
      if (before.label !== label) {
        const after = await pane(["rename", paneId, label]);
        if (after.label !== label) throw failure("Herdr did not confirm the rename.");
      }
      lastNotice = undefined;
    }).catch((error) => {
      if (ctx && current(version)) fail("Herdr rename", error, 0);
    });
  }

  async function name(request: string, version: number, context: ExtensionContext, activity?: NamingInput["activity"]) {
    if (!current(version)) return;
    controller = new AbortController();
    const signal = activeSignal ? AbortSignal.any([controller.signal, activeSignal]) : controller.signal;
    const latestAssistant = activity ? undefined : context.sessionManager.buildContextEntries().findLast((entry) =>
      entry.type === "message" && entry.message.role === "assistant");
    const replyContext = latestAssistant?.type === "message" && latestAssistant.message.role === "assistant"
      ? latestAssistant.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").slice(-600) : "";
    const input: NamingInput = { request: request.slice(0, 2_000), previousTask, currentName: "", replyContext, ...(activity ? { activity } : {}) };
    let stage = "Title model selection";
    let started = performance.now();
    try {
      const model = resolveTitleModel(context, selectedModel());
      if (!model) throw failure("No title model is available. Use /pane-naming model provider/model-id.");
      stage = "Herdr read"; started = performance.now();
      await writes;
      if (!current(version)) return;
      const before = await pane(["get", paneId]);
      if (!current(version)) return;
      const shown = parseLabel(before.label);
      input.currentName = before.label ?? "";
      counts.checks++;
      lastCheckAt = performance.now();
      stage = "Jev"; started = performance.now();
      const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
      const decision = await abortable(check(input, checkSignal), checkSignal);
      if (!current(version)) return;
      if (decision === "keep" || decision === "uncertain") {
        lastNotice = undefined;
        // Re-rendering only changes the label when a confirmed PR was created meanwhile.
        if (decision === "keep" && shown && created.size) render(shown, version);
        return;
      }
      const allowed = [...new Set([...(decision === "new_task" ? [] : shown?.prs ?? []), ...explicitPRs(request)])].slice(0, 4);
      counts.titles++;
      stage = "Title model"; started = performance.now();
      const titleSignal = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
      const title = await abortable(titleModel(model, input, allowed, context, titleSignal), titleSignal);
      if (!current(version)) return;
      previousTask = decision === "new_task" ? input.request : previousTask || input.request;
      render(title, version);
    } catch (error) {
      if (!current(version)) return; // Superseded/cancelled work is not a failure notification.
      fail(stage, error, Math.round(performance.now() - started));
    }
  }

  function enable(context: ExtensionContext) {
    if (!eligible(env, context)) return;
    cancel();
    enabled = true;
    cooldownSeconds = preferences.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
    // Stay on regardless: a later /typesafe login or model change takes effect without re-enabling.
    if (!resolveTitleModel(context, selectedModel())) notify("Pane naming is on, but no title model is available. Use /pane-naming model provider/model-id.", "warning");
    let auth;
    try { auth = typesafeStatus(); } catch { auth = { level: "error", text: "Could not read the TypeSafe key status." }; }
    if (auth.level === "error") notify(`Pane naming is on, but Jev is unavailable: ${auth.text}`, "warning");
  }
  function disable() {
    enabled = false;
    cancel();
  }

  pi.on("session_start", async (_event, context) => {
    ctx = context;
    disable();
    previousTask = "";
    lastCheckAt = -Infinity;
    lastNotice = undefined;
    modelOverride = undefined;
    counts = { checks: 0, titles: 0 };
    desired = undefined;
    activeSignal = context.signal;
    activityText = "";
    if (!eligible(env, context)) return;
    try { activeRequest = latestRequest(context); } catch { activeRequest = ""; }
    try { preferences = readPreferences(dependencies.preferencesFile); }
    catch {
      preferences = {};
      notify("Pane naming could not read its saved preferences; using defaults (on). Fix or delete the preferences file to change them.", "warning");
    }
    if (preferences.enabled !== false || pi.getFlag("pane-naming") === true) enable(context);
  });
  pi.on("session_shutdown", async () => {
    disable();
    // Never wait for a model. Let any already-issued, bounded CLI write settle before session replacement.
    await writes;
    ctx = undefined;
  });
  pi.on("session_before_switch", () => { cancel(); });
  pi.on("session_before_fork", () => { cancel(); });
  pi.on("session_before_tree", () => { cancel(); });
  pi.on("session_tree", (_event, context) => {
    previousTask = "";
    activityText = "";
    try { activeRequest = latestRequest(context); } catch { activeRequest = ""; }
  });

  pi.on("message_start", (event, context) => {
    if (!eligible(env, context) || event.message.role !== "user") return;
    cancel();
    // Every delivered user message counts: typed, queued, /goal, skill, template or extension-sent.
    // message_start is delivery, not queue submission: a queued follow-up cannot rename an earlier task.
    const request = text(event.message.content)?.slice(0, 2_000) ?? "";
    activeRequest = request;
    activeSignal = context.signal;
    activityText = "";
    if (!request.trim()) return;
    void name(request, epoch, context).catch(() => {
      // Malformed context or a disposed Pi runtime must never block the actual request.
    });
  });
  pi.on("message_end", (event, context) => {
    if (!eligible(env, context) || event.message.role !== "assistant") return;
    if (event.message.stopReason === "aborted" || context.signal?.aborted) { cancel(true); return; }
    if (!enabled || !["stop", "toolUse"].includes(event.message.stopReason)) return;
    // Use this event: Pi has not appended the finalized assistant message to session history yet.
    const activity = {
      text: event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").slice(-600),
      tools: [...new Set(event.message.content.filter((block) => block.type === "toolCall")
        .map((block) => block.name).filter((name) => /^[\w.-]{1,64}$/.test(name)))].sort().slice(0, 8),
    };
    if (!activity.text.trim() && !activity.tools.length) return;
    // Providers may emit progress text and the following tool calls in separate messages.
    if (!activity.text.trim()) activity.text = activityText;
    const key = JSON.stringify(activity);
    if (key === lastActivity) return;
    const request = activeRequest;
    cancel(true); // Invalidate old results now; delay only the next paid check, not cancellation.
    activeSignal = context.signal;
    lastActivity = key;
    activityText = activity.text;
    const version = epoch;
    pendingActivity = () => {
      activityTimer = undefined;
      pendingActivity = undefined;
      void name(request, version, context, activity).catch(() => { /* Naming must never block the agent. */ });
    };
    // Latest snapshot wins during the cooldown. No polling, per-tool requests, or automatic retries.
    scheduleActivity();
  });
  pi.on("tool_call", (event) => {
    if (enabled && event.toolName === "bash" && typeof event.input.command === "string" &&
        /^gh\s+pr\s+create(?:\s|$)/.test(event.input.command.trim())) prCalls.set(event.toolCallId, epoch);
  });
  pi.on("tool_result", (event) => {
    const version = prCalls.get(event.toolCallId);
    prCalls.delete(event.toolCallId);
    if (version === undefined || !current(version) || event.isError) return;
    const pr = createdPR(event.input.command, text(event.content) ?? "");
    if (!pr) return;
    created.add(pr);
    if (desired?.epoch === version) render(desired, version);
  });

  pi.registerCommand("pane-naming", {
    description: "Pane naming: on | off | status | cooldown <seconds> | model <provider/model-id>; settings persist for new panes",
    handler: async (args, context) => {
      if (!eligible(env, context)) { context.ui.notify("Pane naming only runs in a main interactive Herdr pane.", "info"); return; }
      ctx = context;
      const [command, ...values] = (args.trim() || "status").split(/\s+/);
      if (values.length !== (["cooldown", "model"].includes(command) ? 1 : 0)) { notify(USAGE); return; }
      const value = values[0];
      if (command === "off") disable(); // Stop this pane even if saving the global default fails.
      try {
        preferences = readPreferences(dependencies.preferencesFile);
        switch (command) {
          case "off":
            savePreferences(dependencies.preferencesFile, { ...preferences, enabled: false });
            preferences.enabled = false;
            notify("Pane naming off here and by default for new panes. Other running panes are unchanged. /pane-naming on turns it back on.");
            break;
          case "on": {
            const next = { ...preferences, enabled: true };
            savePreferences(dependencies.preferencesFile, next);
            preferences = next;
            enable(context);
            notify("Pane naming on here and by default for new panes. It names the pane from the next user message or assistant activity.");
            break;
          }
          case "cooldown": {
            const number = Number(value);
            if (!/^[1-9]\d*$/.test(value) || !validInteger(number, 3_600)) { notify("cooldown requires a whole number from 1 to 3600."); break; }
            const next = { ...preferences, cooldownSeconds: number };
            savePreferences(dependencies.preferencesFile, next);
            preferences = next;
            cooldownSeconds = number;
            scheduleActivity();
            notify(`Saved cooldown: ${number}s. Applied here and to future panes; other running panes are unchanged.`);
            break;
          }
          case "model": {
            if (!/^[^/\s]+\/\S+$/.test(value)) { notify("Use /pane-naming model provider/model-id."); break; }
            const [provider, ...parts] = value.split("/");
            if (!context.modelRegistry.find(provider, parts.join("/"))) { notify("Title model unavailable in Pi. Choose an available provider/model-id; nothing was changed."); break; }
            const next = { ...preferences, titleModel: value };
            savePreferences(dependencies.preferencesFile, next);
            cancel(); // Pending old-model work must not rename after the switch.
            preferences = next;
            modelOverride = value;
            notify(`Saved title model: ${value}. Applied here and to future panes; other running panes are unchanged.`);
            break;
          }
          case "status": {
            const model = resolveTitleModel(context, selectedModel());
            const selected = selectedModel();
            const modelText = model ? `${model.provider}/${model.id}${selected && selected !== `${model.provider}/${model.id}` ? ` (fallback; ${selected} unavailable)` : !selected ? " (default)" : ""}` : "none available";
            let auth;
            try { auth = typesafeStatus().text; } catch { auth = "key status unreadable"; }
            notify(`Pane naming ${enabled ? "on" : "off"}; new-pane default ${preferences.enabled === false ? "off" : "on"}. This session: ${counts.checks} Jev checks, ${counts.titles} title requests. Cooldown: ${cooldownSeconds}s. Title model: ${modelText}. Jev: ${auth}`);
            break;
          }
          default: notify(USAGE);
        }
      } catch {
        notify(command === "off" ? "Pane naming off here, but the global default could not be saved." : "Could not read or save the global pane-naming preferences file. Existing settings were not changed.");
      }
    },
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  register(pi, { preferencesFile: join(getAgentDir(), "pane-naming.json") });
}
