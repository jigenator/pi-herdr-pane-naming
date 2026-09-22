import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  abortable, classify, configuration, DEADLINE_MS, describeFailure, explicitPRs, generateTitle, DEFAULT_CHECK_LIMIT, paneLabel, parseTitle,
  type Config, type NamingInput, type Title,
} from "./models.ts";

const STATE = "herdr-pane-naming";
const CLI_TIMEOUT = 1_500;
const DEFAULT_COOLDOWN_SECONDS = 30;
const USAGE = "Usage: /pane-naming on | off | adopt | status | cooldown <seconds: 1–3600> | limit <checks: 1–1000> | model <provider/model-id>";
type Pane = { pane_id: string; terminal_id: string; label?: string };
type Saved = { sessionId: string; paneId: string; terminalId?: string; label: string | null; title?: Title; checks: number; titles: number };
type Preferences = { enabled: boolean; titleModel?: string; cooldownSeconds?: number; checkLimit?: number };
const validInteger = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;

function readPreferences(file: string): Preferences {
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
    throw new Error("Could not read pane-naming preferences.");
  }
  if (!value || typeof value.enabled !== "boolean" || (value.titleModel !== undefined &&
      (typeof value.titleModel !== "string" || !/^[^/\s]+\/\S+$/.test(value.titleModel))) ||
      (value.cooldownSeconds !== undefined && !validInteger(value.cooldownSeconds, 3_600)) ||
      (value.checkLimit !== undefined && !validInteger(value.checkLimit, 1_000))) {
    throw new Error("Invalid pane-naming preferences.");
  }
  return value;
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

function text(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((block) => block.type !== "text")) return;
  return content.map((block) => block.text).join("");
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function createdPR(command: unknown, output: string): string | undefined {
  // Deliberately not a shell parser: only a single, direct gh pr create is recognized.
  if (typeof command !== "string" || !/^gh\s+pr\s+create(?:\s|$)/.test(command.trim()) ||
      /[;&|<>`$\r\n]/.test(command) || /--(?:dry-run|web|help)\b/.test(command)) return;
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d{0,9})$/.exec(output.trim())?.[1];
}

export function register(pi: ExtensionAPI, dependencies: {
  preferencesFile: string;
  env?: NodeJS.ProcessEnv;
  classify?: typeof classify;
  generateTitle?: typeof generateTitle;
}): void {
  const env = { ...(dependencies.env ?? process.env) };
  const paneId = env.HERDR_PANE_ID ?? ""; // Never accept a target from a model, command argument, or focused pane.
  const check = dependencies.classify ?? classify;
  const titleModel = dependencies.generateTitle ?? generateTitle;
  let ctx: ExtensionContext | undefined;
  let config: Config | undefined;
  let preferences: Preferences = { enabled: false };
  let cooldownSeconds = DEFAULT_COOLDOWN_SECONDS;
  let checkLimit = DEFAULT_CHECK_LIMIT;
  let modelOverride: string | undefined;
  let saved: Saved;
  let enabled = false;
  let epoch = 0;
  let controller: AbortController | undefined;
  let writes = Promise.resolve();
  let previousTask = "";
  let activeRequest: string | undefined;
  let activeSignal: AbortSignal | undefined;
  let lastActivity = "";
  let activityText = "";
  let lastCheckAt = -Infinity;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingActivity: (() => void) | undefined;
  let desired: (Title & { epoch: number }) | undefined;
  let created = new Set<string>();
  const submitted = new Map<string, boolean>();
  const prCalls = new Map<string, number>();

  pi.registerFlag("pane-naming", { description: "Enable paid pane naming for this session (otherwise use the saved default)", type: "boolean", default: false });
  pi.registerFlag("pane-naming-model", { description: "Title model: provider/model-id (overrides the saved model)", type: "string" });
  const selectedModel = () => modelOverride ?? (pi.getFlag("pane-naming-model") || preferences.titleModel);

  function cancel(preserveScope = false) {
    // Keep only an already-displayed title for confirmed PR-prefix updates within this user scope.
    const displayedTitle = preserveScope && desired && paneLabel(desired) === saved.label ? desired : undefined;
    epoch++;
    controller?.abort();
    controller = undefined;
    clearTimeout(activityTimer);
    activityTimer = undefined;
    pendingActivity = undefined;
    if (!preserveScope) {
      activeRequest = undefined;
      activeSignal = undefined;
      activityText = "";
    }
    lastActivity = "";
    desired = displayedTitle ? { ...displayedTitle, epoch } : undefined;
    created = new Set();
    prCalls.clear();
  }
  function notify(message: string) {
    try { ctx?.ui.notify(message, "info"); } catch { /* disposed session */ }
  }
  function persist() { pi.appendEntry(STATE, { ...saved }); }
  function stop(message?: string) {
    enabled = false;
    cancel();
    if (message) notify(message);
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

  async function pane(args: string[]): Promise<Pane> {
    const result = await pi.exec("herdr", ["pane", ...args], { timeout: CLI_TIMEOUT });
    if (result.code !== 0 || result.killed || result.stdout.length > 65_536) throw new Error("Herdr unavailable.");
    const response = JSON.parse(result.stdout);
    const value = response.result?.pane;
    if (response.error || response.result?.type !== "pane_info" || value?.pane_id !== paneId ||
        typeof value.terminal_id !== "string" || !value.terminal_id ||
        (value.label != null && typeof value.label !== "string")) throw new Error("Invalid Herdr response.");
    return value;
  }

  function render(title: Title, version: number) {
    if (!current(version)) return;
    const candidate = { ...title, prs: [...new Set([...title.prs, ...created])].slice(0, 4), epoch: version };
    desired = candidate;
    // Serialize writes; stale work is checked again after every asynchronous read.
    writes = writes.then(async () => {
      if (!current(version) || desired !== candidate) return;
      const before = await pane(["get", paneId]);
      if (!current(version) || desired !== candidate) return;
      if (before.terminal_id !== saved.terminalId || (before.label ?? null) !== saved.label) {
        stop("Pane naming paused: the pane name changed outside this extension. Use /pane-naming adopt only if you want automation to take over.");
        return;
      }
      const label = paneLabel(candidate);
      if (label !== saved.label) {
        // Herdr 0.9 has no conditional rename. A manual rename racing this write cannot be protected atomically.
        const after = await pane(["rename", paneId, label]);
        if (after.terminal_id !== saved.terminalId || after.label !== label) throw new Error("Rename not confirmed.");
        // Track even an already-issued write superseded during the CLI call; never mistake it for a user's rename.
        saved.label = label;
      }
      saved.title = { title: candidate.title, prs: candidate.prs };
      persist();
    }).catch(() => {
      // A failed write may have reached Herdr. Stop instead of blindly retrying or claiming ownership.
      if (ctx) stop("Pane naming paused: Herdr could not confirm the update. Your work continues; no automatic retry.");
    });
  }

  async function name(request: string, version: number, context: ExtensionContext, activity?: NamingInput["activity"]) {
    if (!config || !current(version)) return;
    const localConfig = config;
    controller = new AbortController();
    const signal = activeSignal ? AbortSignal.any([controller.signal, activeSignal]) : controller.signal;
    const latestAssistant = activity ? undefined : context.sessionManager.buildContextEntries().findLast((entry) =>
      entry.type === "message" && entry.message.role === "assistant");
    const replyContext = latestAssistant?.type === "message" && latestAssistant.message.role === "assistant"
      ? latestAssistant.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").slice(-600) : "";
    const input: NamingInput = { request: request.slice(0, 2_000), previousTask, currentName: saved.label ?? "", replyContext, ...(activity ? { activity } : {}) };
    let stage = "Herdr read";
    let started = performance.now();
    try {
      // Do not spend model tokens on a name the user has replaced while Pi was working.
      await writes;
      if (!current(version)) return;
      const before = await pane(["get", paneId]);
      if (!current(version)) return;
      if (before.terminal_id !== saved.terminalId || (before.label ?? null) !== saved.label) {
        stop("Pane naming paused: preserving a name set outside this extension.");
        return;
      }
      if (saved.checks >= checkLimit) {
        stop(`Pane naming paused: the ${checkLimit}-check session limit was reached. Raise /pane-naming limit, then use /pane-naming on to resume.`);
        return;
      }
      input.currentName = saved.label ?? "";
      stage = "Session state"; started = performance.now();
      saved.checks++;
      lastCheckAt = performance.now();
      persist();
      stage = "Jev"; started = performance.now();
      const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
      const decision = await abortable(check(localConfig, input, checkSignal), checkSignal);
      if (!current(version)) return;
      if (decision === "keep") {
        if (saved.title) render(saved.title, version);
        return;
      }
      if (decision === "uncertain") return;
      const allowed = [...new Set([
        ...(decision === "new_task" ? [] : saved.title?.prs ?? []), ...explicitPRs(request),
      ])].slice(0, 4);
      stage = "Session state"; started = performance.now();
      saved.titles++;
      persist();
      stage = "Title model"; started = performance.now();
      const titleSignal = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
      const title = await abortable(titleModel(localConfig, input, allowed, context, titleSignal), titleSignal);
      if (!current(version)) return;
      previousTask = decision === "new_task" ? input.request : previousTask || input.request;
      render(title, version);
    } catch (error) {
      if (!current(version)) return; // Superseded/cancelled work is not a failure notification.
      const reason = describeFailure(error);
      const elapsedMs = Math.round(performance.now() - started);
      try {
        pi.appendEntry(`${STATE}-failure`, {
          sessionId: saved.sessionId, paneId, checks: saved.checks, titles: saved.titles, stage, reason, elapsedMs,
        });
      } catch { /* Diagnostics must not block work when session storage is unavailable. */ }
      notify(`Pane naming failed at ${stage} (${elapsedMs} ms): ${reason} No rename from this attempt; your work continues. No automatic retry.`);
    }
  }

  async function arm(context: ExtensionContext, adopt = false, remember = false) {
    if (!eligible(env, context)) return;
    stop();
    const version = epoch; // Pi creates fresh contexts per callback; lifetime is tracked by the epoch.
    try {
      const nextConfig = configuration(env, selectedModel());
      if (!context.modelRegistry.find(nextConfig.provider, nextConfig.model)) throw new Error("Missing model.");
      await writes;
      if (!ctx || epoch !== version) return;
      const before = await pane(["get", paneId]);
      if (!ctx || epoch !== version) return;
      const owned = saved.terminalId === before.terminal_id && saved.label === (before.label ?? null);
      if (before.label && !owned && !adopt) {
        notify("Pane naming is off: preserving the existing pane name. /pane-naming adopt explicitly lets automation replace it.");
        return;
      }
      if (adopt && !(await context.ui.confirm("Let automatic naming replace this pane's name?", before.label ?? "Unnamed pane"))) return;
      if (!ctx || epoch !== version) return;
      if (remember) {
        const next = { ...preferences, enabled: true, titleModel: `${nextConfig.provider}/${nextConfig.model}` };
        savePreferences(dependencies.preferencesFile, next);
        preferences = next;
      }
      config = nextConfig;
      cooldownSeconds = preferences.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
      checkLimit = preferences.checkLimit ?? DEFAULT_CHECK_LIMIT;
      if (!owned) saved.title = undefined;
      saved.terminalId = before.terminal_id;
      saved.label = before.label ?? null;
      persist();
      enabled = true;
      notify(`Pane naming on: Jev → ${config.provider}/${config.model}; at most ${checkLimit} checks per session; assistant cooldown ${cooldownSeconds}s. Requests, assistant activity excerpts, and tool names leave Pi.${remember ? " Saved: new unnamed Pi panes will start enabled." : ""} Disable the old agent naming instructions before using this alongside the main agent.`);
    } catch {
      if (ctx && epoch === version) notify("Pane naming is off: check the global preferences file, Cloudflare settings, title model, and Herdr CLI. No model requests were made.");
    }
  }

  pi.on("session_start", async (_event, context) => {
    ctx = context;
    stop();
    submitted.clear();
    previousTask = "";
    lastCheckAt = -Infinity;
    modelOverride = undefined;
    cooldownSeconds = DEFAULT_COOLDOWN_SECONDS;
    checkLimit = DEFAULT_CHECK_LIMIT;
    saved = { sessionId: context.sessionManager.getSessionId(), paneId, label: null, checks: 0, titles: 0 };
    for (const entry of context.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== STATE) continue;
      const data = entry.data as Saved | undefined;
      if (data?.sessionId !== saved.sessionId || data.paneId !== paneId ||
          !Number.isSafeInteger(data.checks) || data.checks < 0 || !Number.isSafeInteger(data.titles) || data.titles < 0) continue;
      if ((data.label !== null && (typeof data.label !== "string" || [...data.label].length > 80)) ||
          (data.terminalId !== undefined && typeof data.terminalId !== "string")) continue;
      try {
        if (data.title) parseTitle(JSON.stringify(data.title), data.title.prs.filter((pr) => /^[1-9]\d{0,9}$/.test(pr)));
        saved = { ...data };
      } catch { /* Ignore malformed persisted ownership; never adopt its label. */ }
    }
    if (!eligible(env, context)) return;
    try {
      preferences = readPreferences(dependencies.preferencesFile);
      cooldownSeconds = preferences.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS;
      checkLimit = preferences.checkLimit ?? DEFAULT_CHECK_LIMIT;
      if (preferences.enabled || pi.getFlag("pane-naming") === true) await arm(context);
    } catch { notify("Pane naming is off: could not read the global preferences file."); }
  });
  pi.on("session_shutdown", async () => {
    stop();
    // Never wait for a model. Let any already-issued, bounded CLI write settle before session replacement.
    await writes;
    ctx = undefined;
    config = undefined;
    submitted.clear();
  });
  pi.on("session_before_switch", () => { cancel(); });
  pi.on("session_before_fork", () => { cancel(); });
  pi.on("session_before_tree", () => { cancel(); });
  pi.on("session_tree", () => { previousTask = ""; submitted.clear(); });
  // Do not let a later extension-only run inherit human scope or pending naming work.
  pi.on("agent_settled", () => { activeRequest = undefined; });
  pi.on("agent_start", () => { if (!activeRequest) cancel(); });

  pi.on("input", (event, context) => {
    if (!enabled || !eligible(env, context)) return;
    const key = hash(event.text);
    const human = event.source === "interactive" && !event.images?.length && !event.text.trimStart().startsWith("/");
    // An ambiguous same-text submission from an automated source must not inherit human provenance.
    submitted.set(key, human && submitted.get(key) !== false);
    if (submitted.size > 64) submitted.delete(submitted.keys().next().value!);
  });
  pi.on("message_start", (event, context) => {
    if (!enabled || !eligible(env, context)) return;
    if (event.message.role === "custom") { cancel(); return; }
    if (event.message.role !== "user") return;
    cancel();
    const request = text(event.message.content);
    if (!request) return;
    const key = hash(request);
    const human = submitted.get(key);
    submitted.delete(key);
    if (!human) return;
    activeRequest = request.slice(0, 2_000);
    activeSignal = context.signal;
    // message_start is delivery, not queue submission: queued follow-ups cannot rename an earlier task.
    void name(request, epoch, context).catch(() => {
      // Malformed context or a disposed Pi runtime must never block the actual request.
    });
  });
  pi.on("message_end", (event, context) => {
    if (!enabled || !eligible(env, context) || !activeRequest || event.message.role !== "assistant") return;
    if (event.message.stopReason === "aborted" || context.signal?.aborted) { cancel(); return; }
    if (!["stop", "toolUse"].includes(event.message.stopReason)) return;
    // Use this event: Pi has not appended the finalized assistant message to session history yet.
    const activity = {
      text: event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").slice(-600),
      tools: [...new Set(event.message.content.filter((block) => block.type === "toolCall")
        .map((block) => block.name).filter((name) => /^[\w.-]{1,64}$/.test(name)))].sort().slice(0, 8),
    };
    if (!activity.text.trim() && !activity.tools.length) return;
    // Providers may emit progress text and the following tool calls in separate messages.
    if (!activity.text.trim()) activity.text = activityText;
    const key = hash(JSON.stringify(activity));
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
    description: "Pane naming: on | off | adopt | status | cooldown <seconds> | limit <checks> | model <provider/model-id>; settings persist",
    handler: async (args, context) => {
      if (!eligible(env, context)) { context.ui.notify("Pane naming only runs in a main interactive Herdr pane.", "info"); return; }
      const [command, ...values] = (args.trim() || "status").split(/\s+/);
      if (values.length !== (["cooldown", "limit", "model"].includes(command) ? 1 : 0)) { notify(USAGE); return; }
      const value = values[0];
      if (command === "off") stop(); // Stop this pane even if saving the global default fails.
      try {
        preferences = readPreferences(dependencies.preferencesFile);
        switch (command) {
          case "off":
            savePreferences(dependencies.preferencesFile, { ...preferences, enabled: false });
            preferences.enabled = false;
            notify("Pane naming off here and by default for new panes. Other running panes are unchanged.");
            break;
          case "on":
          case "adopt":
            await arm(context, command === "adopt", true);
            break;
          case "cooldown":
          case "limit": {
            const number = Number(value);
            const maximum = command === "cooldown" ? 3_600 : 1_000;
            if (!/^[1-9]\d*$/.test(value) || !validInteger(number, maximum)) {
              notify(`${command} requires a whole number from 1 to ${maximum}.`); break;
            }
            const key = command === "cooldown" ? "cooldownSeconds" : "checkLimit";
            const next = { ...preferences, [key]: number };
            savePreferences(dependencies.preferencesFile, next);
            preferences = next;
            if (command === "cooldown") {
              cooldownSeconds = number;
              scheduleActivity();
            } else {
              checkLimit = number;
              if (enabled && saved.checks >= checkLimit) stop("Pane naming paused: the new limit is already used. Attempts were not reset.");
            }
            notify(`Saved ${command}: ${number}${command === "cooldown" ? "s" : " checks"}. Applied here and to future panes; other running panes are unchanged.${!enabled ? " Naming remains off; use /pane-naming on to enable it." : ""}`);
            break;
          }
          case "model": {
            if (!/^[^/\s]+\/\S+$/.test(value)) { notify("Use /pane-naming model provider/model-id."); break; }
            const [provider, ...parts] = value.split("/");
            const model = parts.join("/");
            if (!context.modelRegistry.find(provider, model)) { notify("Title model unavailable in Pi. Choose an available provider/model-id; nothing was changed."); break; }
            const next = { ...preferences, titleModel: value };
            savePreferences(dependencies.preferencesFile, next);
            cancel(true); // Also invalidate an in-progress on/adopt that captured an older model.
            preferences = next;
            modelOverride = value;
            if (config) config = { ...config, provider, model };
            notify(`Saved title model: ${value}. Applied here and to future panes; other running panes are unchanged.${!enabled ? " Naming remains off; use /pane-naming on to enable it." : " Pending old-model work was cancelled; future activity uses this model."}`);
            break;
          }
          case "status":
            notify(`Pane naming ${enabled ? "on" : "off"}; new-pane default ${preferences.enabled ? "on" : "off"}; Jev checks ${saved.checks}/${checkLimit}, title requests ${saved.titles}. Cooldown: ${cooldownSeconds}s. Title model: ${enabled && config ? `${config.provider}/${config.model}` : selectedModel() || "not selected"}. Saved defaults: cooldown ${preferences.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS}s, limit ${preferences.checkLimit ?? DEFAULT_CHECK_LIMIT}, model ${preferences.titleModel || "not selected"}.`);
            break;
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
