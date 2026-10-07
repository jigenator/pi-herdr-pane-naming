import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";
import fs, { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTypeSafe, TypeSafeIntegrationError, type UsageLedger } from "pi-typesafe";
import { createdPR, eligible, register } from "../index.ts";
import {
  abortable, classify, DEADLINE_MS, describeFailure, explicitPRs, failure, FALLBACK_TITLE_MODEL, generateTitle, paneLabel,
  parseLabel, parseTitle, resolveTitleModel,
} from "../models.ts";

const preferencesDirectory = mkdtempSync(join(tmpdir(), "pane-naming-preferences-"));
// pi-typesafe records key verification/failure next to its key store; keep that out of the real ~/.pi.
const agentDirectory = mkdtempSync(join(tmpdir(), "pane-naming-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDirectory;
let harnessId = 0;
after(() => Promise.all([preferencesDirectory, agentDirectory].map((directory) => rm(directory, { recursive: true, force: true }))));
const env = { HERDR_ENV: "1", HERDR_PANE_ID: "own-pane" };
const title = { title: "Fix login", prs: [] };
const input = { request: "Fix login", previousTask: "", currentName: "", replyContext: "" };
const USAGE = "Usage: /pane-naming on | off | status | cooldown <seconds: 1–3600> | model <provider/model-id>";
const SAVE_FAILED = "Could not read or save the global pane-naming preferences file. Existing settings were not changed.";
const deferred = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((done) => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await setImmediate(); }
  assert.ok(predicate(), "background operation did not settle");
}
async function settle() { for (let i = 0; i < 12; i++) await setImmediate(); }
function activityClock(t: TestContext) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return async (ms = 30_000) => { now += ms; t.mock.timers.tick(ms); await settle(); };
}
const userMessage = (content: any, id = "user") => ({ type: "message", id, message: { role: "user", content } });
const assistantMessage = (content: any, id = "assistant") => ({ type: "message", id, message: { role: "assistant", stopReason: "stop", content } });

function harness(options: any = {}) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, Function>();
  const flags: any = { ...options.flags };
  const preferencesFile = options.preferencesFile ?? join(preferencesDirectory, `${++harnessId}.json`);
  if (options.preferences !== undefined) {
    writeFileSync(preferencesFile, typeof options.preferences === "string" ? options.preferences : JSON.stringify(options.preferences));
  }
  const entries: any[] = [];
  const calls: any[] = [], checks: any[] = [], titles: any[] = [], notices: string[] = [];
  const paneId = options.env?.HERDR_PANE_ID ?? env.HERDR_PANE_ID;
  const pane: any = { pane_id: paneId, terminal_id: "terminal-1", ...(options.label ? { label: options.label } : {}) };
  const session = { history: options.history ?? [], branch: options.branch ?? options.history ?? [] };
  const models: string[] = options.models ?? [FALLBACK_TITLE_MODEL, "google/test-model", "google/new-model"];
  const modelObjects = new Map<string, any>();
  const ctx: any = {
    mode: options.mode ?? "tui", hasUI: options.mode !== "print", isIdle: () => true, model: options.sessionModel,
    ui: { notify: (message: string) => notices.push(message), confirm: async () => { throw new Error("Pane naming must not ask for confirmation"); } },
    sessionManager: {
      getSessionId: () => "session-1", getEntries: () => entries,
      getBranch: () => session.branch, buildContextEntries: () => session.history,
    },
    modelRegistry: {
      find: (provider: string, id: string) => {
        const key = `${provider}/${id}`;
        if (!models.includes(key)) return undefined;
        if (!modelObjects.has(key)) modelObjects.set(key, { provider, id });
        return modelObjects.get(key);
      },
      hasConfiguredAuth: (model: any) => !(options.unauthorized ?? []).includes(`${model.provider}/${model.id}`),
    },
  };
  const pi: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerFlag: () => {}, getFlag: (name: string) => flags[name],
    registerCommand: (name: string, command: any) => commands.set(name, command.handler),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    exec: async (bin: string, args: string[], opts: any) => {
      calls.push({ bin, args, opts });
      assert.equal(bin, "herdr");
      assert.equal(args[0], "pane"); assert.equal(args[2], paneId); assert.equal(opts.timeout, 1500);
      const act = async () => {
        if (args[1] === "rename") {
          assert.equal(args.length, 4); assert.equal(args[3].startsWith("-"), false); pane.label = args[3];
        } else assert.equal(args[1], "get");
        return { code: 0, killed: false, stderr: "", stdout: JSON.stringify({ result: { type: "pane_info", pane } }) };
      };
      return options.exec ? options.exec(args, act, pane) : act();
    },
  };
  register(pi, {
    preferencesFile,
    env: { ...env, ...options.env },
    classify: async (data, signal) => { checks.push({ data, signal }); return options.check ? options.check(data, signal) : "new_task"; },
    generateTitle: async (model, data, allowed, _ctx, signal) => {
      titles.push({ model, data, allowed, signal }); return options.title ? options.title(data, allowed, signal) : title;
    },
    typesafeStatus: options.typesafeStatus ?? (() => ({ level: "ok", text: "TypeSafe key: verified." })),
  });
  // Pi creates fresh context objects for each event and command, even within one session.
  const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, { ...ctx });
  const deliver = (content: any) => emit("message_start", { message: {
    role: "user", content: typeof content === "string" ? [{ type: "text", text: content }] : content,
  } });
  const send = async (content: any) => { await deliver(content); await settle(); };
  const assistant = (content: any, extra: any = {}) => emit("message_end", { message: {
    role: "assistant", stopReason: "stop", content: typeof content === "string" ? [{ type: "text", text: content }] : content, ...extra,
  } });
  const command = (arg: string) => commands.get("pane-naming")!(arg, { ...ctx });
  const renames = () => calls.filter((call) => call.args[1] === "rename");
  const failures = () => entries.filter((entry) => entry.customType === "herdr-pane-naming-failure");
  return { emit, deliver, send, assistant, command, renames, failures, pane, flags, entries, calls, checks, titles, notices, ctx, session, models, preferencesFile };
}
const savedPreferences = async (h: { preferencesFile: string }) => JSON.parse(await readFile(h.preferencesFile, "utf8"));

// 1. Eligibility

test("only the main interactive inherited Herdr pane is eligible", async (t) => {
  const tick = activityClock(t);
  assert.equal(eligible(env, { mode: "tui" }), true);
  for (const [environment, mode] of [
    [{ ...env, HERDR_ENV: "0" }, "tui"], [{ ...env, HERDR_PANE_ID: "" }, "tui"], [{ HERDR_ENV: "1" }, "tui"],
    [{ ...env, PI_SUBAGENT_CHILD: "1" }, "tui"], [env, "rpc"], [env, "print"], [env, "json"],
  ] as const) assert.equal(eligible(environment, { mode } as any), false);
  for (const options of [{ mode: "rpc" }, { mode: "print" }, { mode: "json" }, { env: { HERDR_ENV: "0" } }, { env: { HERDR_PANE_ID: "" } }, { env: { PI_SUBAGENT_CHILD: "1" } }]) {
    const h = harness({ ...options, typesafeStatus: () => ({ level: "error", text: "missing" }) });
    await h.emit("session_start"); await h.send("Fix login");
    await h.assistant("Now debugging login"); await tick();
    for (const command of ["on", "cooldown 5", "model google/test-model", "status"]) await h.command(command);
    assert.equal(h.calls.length, 0); assert.equal(h.checks.length, 0); assert.equal(h.titles.length, 0);
    assert.deepEqual(h.notices, Array(4).fill("Pane naming only runs in a main interactive Herdr pane."));
    await assert.rejects(readFile(h.preferencesFile), { code: "ENOENT" });
  }
});

// 2. Default on, saved off, flag, invalid and legacy preferences

test("naming is on by default with no saved preferences or flags", async () => {
  const h = harness(); await h.emit("session_start");
  assert.equal(h.calls.length, 0); assert.equal(h.checks.length, 0, "startup must not call Herdr or a model");
  assert.deepEqual(h.notices, []);
  await h.deliver("Fix login"); await until(() => h.renames().length === 1);
  assert.equal(h.pane.label, "Fix login"); assert.equal(h.renames()[0].args[2], "own-pane");
  await assert.rejects(readFile(h.preferencesFile), { code: "ENOENT" }, "startup never saves preferences");
  await h.command("status"); assert.match(h.notices.at(-1)!, /^Pane naming on; new-pane default on\./);
});

test("a saved off keeps new panes off; --pane-naming forces this session on without saving", async () => {
  const off = harness({ preferences: { enabled: false, cooldownSeconds: 7 } });
  await off.emit("session_start"); await off.send("Fix login");
  assert.equal(off.calls.length, 0); assert.equal(off.checks.length, 0);
  await off.command("status");
  assert.match(off.notices.at(-1)!, /^Pane naming off; new-pane default off\./);
  assert.ok(off.notices.at(-1)!.includes("Cooldown: 7s"), "status shows the saved cooldown while off");
  const forced = harness({ preferences: { enabled: false }, flags: { "pane-naming": true } });
  await forced.emit("session_start"); await forced.deliver("Fix login"); await until(() => forced.renames().length === 1);
  assert.deepEqual(await savedPreferences(forced), { enabled: false });
  await forced.command("status"); assert.match(forced.notices.at(-1)!, /^Pane naming on; new-pane default off\./);
});

test("unreadable or invalid preferences warn, use defaults, and are never overwritten; off still stops this pane", async () => {
  const invalid: (string | null)[] = [
    '{"enabled":true,"PRIVATE_MARKER":', JSON.stringify(null), JSON.stringify("PRIVATE_MARKER"),
    JSON.stringify({ enabled: "PRIVATE_MARKER" }), JSON.stringify({ titleModel: "PRIVATE_MARKER-no-provider" }),
    JSON.stringify({ titleModel: 5 }), JSON.stringify({ cooldownSeconds: 0 }), JSON.stringify({ cooldownSeconds: 1.5 }),
    JSON.stringify({ cooldownSeconds: 3601 }), JSON.stringify({ cooldownSeconds: "PRIVATE_MARKER" }), JSON.stringify(["PRIVATE_MARKER"]),
    null, // A directory where the file should be: unreadable, not missing.
  ];
  for (const raw of invalid) {
    const preferencesFile = join(preferencesDirectory, `${++harnessId}.json`);
    if (raw === null) mkdirSync(preferencesFile); else writeFileSync(preferencesFile, raw);
    const h = harness({ preferencesFile });
    await h.emit("session_start");
    assert.deepEqual(h.notices, ["Pane naming could not read its saved preferences; using defaults (on). Fix or delete the preferences file to change them."], String(raw));
    await h.deliver("Fix login"); await until(() => h.renames().length === 1);
    for (const command of ["on", "cooldown 5", "model google/test-model", "status"]) {
      await h.command(command); assert.equal(h.notices.at(-1), SAVE_FAILED, command);
    }
    await h.command("off");
    assert.equal(h.notices.at(-1), "Pane naming off here, but the global default could not be saved.");
    await h.send("Next task"); assert.equal(h.checks.length, 1, "off stops this pane even though it could not be saved");
    if (raw !== null) assert.equal(await readFile(preferencesFile, "utf8"), raw);
    assert.equal(h.notices.join("\n").includes("PRIVATE_MARKER"), false);
  }
});

test("a legacy checkLimit field is accepted, ignored, and dropped on the next save", async (t) => {
  const tick = activityClock(t);
  for (const checkLimit of [3, 0, "PRIVATE_MARKER", null]) {
    const h = harness({ preferences: { enabled: true, titleModel: "google/test-model", cooldownSeconds: 5, checkLimit }, check: () => "keep" });
    await h.emit("session_start"); assert.deepEqual(h.notices, []);
    for (let i = 0; i < 5; i++) await h.send(`Task ${i}`);
    assert.equal(h.checks.length, 5, "the old limit is not enforced");
    await h.assistant("Debugging login"); await tick(4_999); assert.equal(h.checks.length, 5);
    await tick(1); assert.equal(h.checks.length, 6, "the saved cooldown still applies");
    await h.command("status");
    assert.ok(h.notices.at(-1)!.includes("Cooldown: 5s")); assert.ok(h.notices.at(-1)!.includes("Title model: google/test-model."));
    await h.command("cooldown 7");
    assert.deepEqual(await savedPreferences(h), { enabled: true, titleModel: "google/test-model", cooldownSeconds: 7 });
  }
});

// 3. Existing labels

test("existing labels are taken over at the next decision without confirmation; adopt and limit are gone", async () => {
  const h = harness({ label: "My chosen name" }); await h.emit("session_start");
  assert.equal(h.pane.label, "My chosen name"); assert.equal(h.calls.length, 0);
  await h.deliver("Fix login"); await until(() => h.renames().length === 1);
  assert.equal(h.checks[0].data.currentName, "My chosen name"); assert.equal(h.pane.label, "Fix login");
  for (const command of ["adopt", "limit 3", "limit"]) { await h.command(command); assert.equal(h.notices.at(-1), USAGE, command); }
  await assert.rejects(readFile(h.preferencesFile), { code: "ENOENT" });
});

// 4. Manual renames

test("manual renames before or during model work never pause naming", async (t) => {
  const tick = activityClock(t);
  for (const during of [false, true]) {
    const pending = deferred(); let first = true;
    const h = harness({ title: (data: any) => {
      if (first) { first = false; return pending.promise; }
      return { title: data.activity?.text ?? data.request, prs: [] };
    } });
    await h.emit("session_start");
    if (!during) h.pane.label = "User name";
    await h.deliver("Fix login"); await until(() => h.titles.length === 1);
    if (during) h.pane.label = "User name";
    pending.resolve(title); await until(() => h.pane.label === "Fix login");
    if (!during) assert.equal(h.checks[0].data.currentName, "User name");
    h.pane.label = "Another manual name";
    await h.send("Next task"); assert.equal(h.pane.label, "Next task");
    h.pane.label = "Typed during activity";
    await h.assistant("Debugging next task"); await tick(); assert.equal(h.pane.label, "Debugging next task");
    assert.equal(h.failures().length, 0);
  }
  const pending = deferred();
  const h = harness({ check: (data: any) => data.activity ? pending.promise : "keep", title: (data: any) => ({ title: data.activity.text, prs: [] }) });
  await h.emit("session_start"); await h.send("Fix login");
  await h.assistant("Now debugging login"); await tick(); assert.equal(h.checks.length, 2);
  h.pane.label = "Manual name during Jev"; pending.resolve("update"); await settle();
  assert.equal(h.pane.label, "Now debugging login");
});

// 5. Delivered user messages

test("every delivered user message is checked without an input event; only text blocks are sent", async () => {
  const h = harness({ check: () => "keep" }); await h.emit("session_start");
  await h.send("/goal expanded goal text");
  await h.emit("message_start", { message: { role: "user", content: "Expanded skill template" } }); await settle();
  await h.send([{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }, { type: "text", text: "Look at " }, { type: "text", text: "this" }]);
  await h.send([{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }]);
  await h.send("   \n ");
  await h.send([{ type: "text", text: " " }, { type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }]);
  await h.emit("message_start", { message: { role: "custom", content: "Injected custom message" } }); await settle();
  await h.emit("message_start", { message: { role: "assistant", content: [{ type: "text", text: "Assistant start" }] } }); await settle();
  assert.deepEqual(h.checks.map((check) => check.data.request), ["/goal expanded goal text", "Expanded skill template", "Look at this"]);
  assert.equal(JSON.stringify(h.checks).includes("PRIVATE_IMAGE"), false);
});

test("queued input is only checked on delivery and does not cancel current work", async (t) => {
  const tick = activityClock(t);
  const h = harness({ check: () => "keep" }); await h.emit("session_start");
  await h.send("Research login"); await h.assistant("Now debugging login");
  await h.emit("input", { text: "queued task", source: "interactive", streamingBehavior: "followUp" });
  await tick();
  assert.equal(h.checks.length, 2); assert.equal(h.checks[1].data.request, "Research login");
  await h.send("queued task");
  assert.equal(h.checks.length, 3); assert.equal(h.checks[2].data.request, "queued task");
});

// 6. Activity scope

test("custom-role messages do not end the activity scope", async (t) => {
  const tick = activityClock(t);
  const h = harness({ check: () => "keep" }); await h.emit("session_start"); await h.send("Research login");
  await h.emit("message_start", { message: { role: "custom", content: "Injected work" } });
  await h.emit("message_end", { message: { role: "custom", content: "Injected work" } });
  await h.assistant("Now debugging login"); await tick();
  assert.equal(h.checks.length, 2); assert.equal(h.checks[1].data.request, "Research login");
});

test("session start of any reason anchors activity on the branch's latest user message", async () => {
  for (const reason of ["startup", "reload", "resume", "new", "fork"]) {
    const history = [
      userMessage("Old request", "u1"), assistantMessage([{ type: "text", text: "Done" }], "a1"),
      { type: "custom_message", id: "c1", content: "Injected" },
      userMessage([{ type: "image", data: "PRIVATE_IMAGE" }, { type: "text", text: "Fix login" }], "u2"),
      assistantMessage([{ type: "toolCall", name: "bash", arguments: {} }], "a2"),
    ];
    const h = harness({ history, title: (data: any) => ({ title: data.activity ? "Debugging login" : "Unexpected", prs: [] }) });
    await h.emit("session_start", { reason });
    assert.equal(h.checks.length, 0, "starting a session must not replay a request");
    await h.assistant("Now debugging login"); await settle();
    assert.equal(h.checks.length, 1, reason);
    assert.equal(h.checks[0].data.request, "Fix login");
    assert.deepEqual(h.checks[0].data.activity, { text: "Now debugging login", tools: [] });
    assert.equal(h.pane.label, "Debugging login");
  }
});

test("tree navigation re-anchors activity on the new branch and clears the previous task", async (t) => {
  const tick = activityClock(t);
  const h = harness({ history: [userMessage("Branch A request")], title: (data: any) => ({ title: data.activity?.text ?? data.request, prs: [] }) });
  await h.emit("session_start"); await h.send("Fix login");
  assert.equal(h.pane.label, "Fix login");
  await h.emit("session_before_tree");
  h.session.branch = [userMessage("Branch B request", "b1"), assistantMessage([{ type: "text", text: "Answer" }], "b2")];
  await h.emit("session_tree");
  await h.assistant("Working on branch B"); await tick();
  assert.equal(h.checks.length, 2);
  assert.equal(h.checks[1].data.request, "Branch B request"); assert.equal(h.checks[1].data.previousTask, "");
  assert.equal(h.pane.label, "Working on branch B");
});

test("activity naming works when the branch has no user message", async () => {
  const h = harness({ title: () => ({ title: "Exploring the repository", prs: [] }) });
  await h.emit("session_start");
  await h.assistant("Exploring the repository layout."); await settle();
  assert.equal(h.checks.length, 1); assert.equal(h.checks[0].data.request, "");
  assert.equal(h.pane.label, "Exploring the repository");
});

// 7. Cooldown and coalescing

test("assistant activity renames without another prompt, coalesces bursts and skips repeated snapshots", async (t) => {
  const tick = activityClock(t);
  const h = harness({ title: (data: any) => ({ title: data.activity ? "Debugging login" : "Login research", prs: [] }) });
  await h.emit("session_start"); await h.send("Investigate login failures");
  await h.assistant("I am researching login failures.");
  await tick(10_000);
  await h.assistant("I found the cause; now debugging login.");
  await tick(19_999); assert.equal(h.checks.length, 1);
  await tick(1);
  assert.equal(h.pane.label, "Debugging login"); assert.equal(h.checks.length, 2);
  assert.equal(h.checks[1].data.request, "Investigate login failures");
  assert.deepEqual(h.checks[1].data.activity, { text: "I found the cause; now debugging login.", tools: [] });
  await h.assistant("I found the cause; now debugging login."); await tick();
  assert.equal(h.checks.length, 2, "unchanged activity is not retried");
  for (const stopReason of ["pending", "length", "error", "deferred"]) { await h.assistant("Incomplete activity", { stopReason }); await tick(); }
  await h.assistant([{ type: "thinking", thinking: "Not visible" }]);
  await h.emit("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "Tool text" }] } });
  await tick(); assert.equal(h.checks.length, 2, "incomplete, thinking-only and non-assistant messages are not activity");
  assert.equal(JSON.stringify(h.entries).includes("I found the cause"), false);
});

test("tool-only messages reuse the latest progress text; a new request clears it", async (t) => {
  const tick = activityClock(t); const h = harness({ check: () => "keep" });
  await h.emit("session_start"); await h.send("Research login");
  await h.assistant("Now debugging login.");
  await h.assistant([{ type: "toolCall", name: "bash", arguments: { command: "PRIVATE_ARGUMENT" } }], { stopReason: "toolUse" });
  await tick();
  assert.equal(h.checks.length, 2);
  assert.deepEqual(h.checks[1].data.activity, { text: "Now debugging login.", tools: ["bash"] });
  await h.send("Research gardening");
  await h.assistant([{ type: "toolCall", name: "web_search", arguments: {} }], { stopReason: "toolUse" });
  await tick(); assert.deepEqual(h.checks.at(-1).data.activity, { text: "", tools: ["web_search"] });
  assert.equal(JSON.stringify(h.checks).includes("PRIVATE_"), false);
});

test("tool-only assistant activity sends bounded names, not arguments, results or thinking", async (t) => {
  const tick = activityClock(t); const h = harness({ check: () => "keep" });
  await h.emit("session_start"); await h.send("Research login");
  const tools = ["web_search", "fetch_content", "web_search"].map((name, i) => ({
    type: "toolCall", id: `call-${i}`, name, arguments: { query: "PRIVATE_ARGUMENT", path: "PRIVATE_PATH" },
  }));
  await h.assistant([{ type: "thinking", thinking: "PRIVATE_THINKING" }, ...tools], { stopReason: "toolUse" });
  await h.emit("tool_result", { toolCallId: "call-0", toolName: "web_search", input: {}, content: [{ type: "text", text: "PRIVATE_RESULT" }] });
  await tick();
  assert.equal(h.checks.length, 2);
  assert.deepEqual(h.checks[1].data.activity, { text: "", tools: ["fetch_content", "web_search"] });
  await h.assistant([...tools].reverse(), { stopReason: "toolUse" }); await tick();
  assert.equal(h.checks.length, 2, "order, call IDs and arguments do not imply an activity change");
  await h.assistant([
    { type: "text", text: "x".repeat(2_000) }, ...Array.from({ length: 20 }, (_, i) => ({ type: "toolCall", name: `tool_${i}`, arguments: {} })),
    { type: "toolCall", name: "PRIVATE_INVALID name", arguments: {} }, { type: "toolCall", name: `a${"b".repeat(64)}`, arguments: {} },
  ], { stopReason: "toolUse" }); await tick();
  assert.equal(h.checks[2].data.activity.text.length, 600);
  assert.deepEqual(h.checks[2].data.activity.tools, ["tool_0", "tool_1", "tool_10", "tool_11", "tool_12", "tool_13", "tool_14", "tool_15"]);
  assert.equal(h.checks[2].data.replyContext, "");
  assert.equal(JSON.stringify([h.checks, h.entries, h.notices]).includes("PRIVATE_"), false);
});

test("the saved cooldown applies at startup and cooldown commands reschedule queued activity", async (t) => {
  const tick = activityClock(t);
  const saved = harness({ preferences: { cooldownSeconds: 5 }, check: () => "keep" });
  await saved.emit("session_start"); await saved.send("Fix login");
  await saved.assistant("Debugging login"); await tick(4_999); assert.equal(saved.checks.length, 1);
  await tick(1); assert.equal(saved.checks.length, 2);
  const h = harness({ check: () => "keep" });
  await h.emit("session_start"); await h.send("Fix login");
  await h.assistant("Debugging login"); await tick(10_000); await h.command("cooldown 60");
  assert.deepEqual(await savedPreferences(h), { cooldownSeconds: 60 });
  await tick(20_000); assert.equal(h.checks.length, 1, "the old 30s timer must not run");
  await tick(29_999); assert.equal(h.checks.length, 1); await tick(1); assert.equal(h.checks.length, 2);
  await h.assistant("Testing login"); await tick(10_000); await h.command("cooldown 5"); await settle();
  assert.equal(h.checks.length, 3, "an already-queued, now-due check may run immediately");
  await tick(60_000); assert.equal(h.checks.length, 3, "no duplicate timer or polling");
  for (const value of [1, 3600]) { await h.command(`cooldown ${value}`); assert.equal((await savedPreferences(h)).cooldownSeconds, value); }
});

// 8. No per-session cap

test("there is no per-session check cap", async (t) => {
  const tick = activityClock(t);
  let decision = "keep";
  const h = harness({ check: () => decision, title: (data: any) => ({ title: data.activity?.text ?? data.request, prs: [] }) });
  await h.emit("session_start");
  for (let i = 0; i < 200; i++) await h.send(`Request ${i}`);
  for (let i = 0; i < 50; i++) { await h.assistant(`Phase ${i}`); await tick(); }
  assert.equal(h.checks.length, 250); assert.equal(h.checks.at(-1).data.request, "Request 199");
  decision = "new_task";
  await h.send("Request 250"); assert.equal(h.checks.length, 251); assert.equal(h.pane.label, "Request 250");
  await h.command("status");
  assert.ok(h.notices.at(-1)!.startsWith("Pane naming on; new-pane default on. This session: 251 Jev checks, 1 title requests."));
  assert.equal(h.failures().length, 0); assert.equal(h.notices.length, 1);
});

// 9. Failures

test("failures record their stage and sanitized reason, warn, and never disable naming", async () => {
  const herdrFailure = (result: any) => async (args: string[], act: Function) => args[1] === "get" ? result : act();
  const renameFailure = (result: (pane: any) => any) => async (args: string[], act: Function, pane: any) => args[1] === "rename" ? result(pane) : act();
  const cases: [string, string, any, number, number][] = [
    ["Herdr read", "Unexpected error (details withheld).", { exec: async () => { throw new Error("PRIVATE_MARKER"); } }, 0, 0],
    ["Herdr read", "Herdr CLI unavailable.", { exec: herdrFailure({ code: 1, killed: false, stderr: "PRIVATE_MARKER", stdout: "" }) }, 0, 0],
    ["Herdr read", "Herdr CLI unavailable.", { exec: herdrFailure({ code: 0, killed: true, stderr: "", stdout: "" }) }, 0, 0],
    ["Herdr read", "Herdr returned invalid JSON.", { exec: herdrFailure({ code: 0, killed: false, stderr: "", stdout: "PRIVATE_MARKER" }) }, 0, 0],
    ["Herdr read", "Invalid Herdr response.", { exec: herdrFailure({ code: 0, killed: false, stderr: "", stdout: JSON.stringify({ error: "PRIVATE_MARKER" }) }) }, 0, 0],
    ["Herdr read", "Invalid Herdr response.", { exec: herdrFailure({ code: 0, killed: false, stderr: "", stdout: "null" }) }, 0, 0],
    // The read inside a rename (after Jev and the title model) is reported as a read, not a rename.
    ["Herdr read", "Herdr CLI unavailable.", { exec: (() => {
      let gets = 0;
      return async (args: string[], act: Function) => args[1] === "get" && ++gets === 2 ? { code: 1, killed: false, stderr: "", stdout: "" } : act();
    })() }, 1, 1],
    ["Herdr rename", "Herdr CLI unavailable.", { exec: renameFailure(() => ({ code: 1, killed: false, stderr: "PRIVATE_MARKER", stdout: "" })) }, 1, 1],
    ["Herdr rename", "Herdr did not confirm the rename.", { exec: renameFailure((pane) => ({
      code: 0, killed: false, stderr: "", stdout: JSON.stringify({ result: { type: "pane_info", pane } }),
    })) }, 1, 1],
    ["Jev", "Unexpected error (details withheld).", { check: () => { throw new Error("PRIVATE_MARKER"); } }, 1, 0],
    ["Jev", "Provider HTTP 503.", { check: () => { throw Object.assign(new Error("PRIVATE_MARKER"), { status: 503 }); } }, 1, 0],
    ["Jev", "TypeSafe returned HTTP 401. Check TYPESAFE_API_KEY. No automatic retry was made.", {
      check: () => { throw failure("TypeSafe returned HTTP 401. Check TYPESAFE_API_KEY. No automatic retry was made."); },
    }, 1, 0],
    ["Title model", "Unexpected error (details withheld).", { title: () => { throw new Error("PRIVATE_MARKER"); } }, 1, 1],
    ["Title model", "Title model returned invalid JSON.", { title: () => parseTitle("PRIVATE_MARKER invalid JSON", []) }, 1, 1],
    ["Title model", "Title selected a PR outside the allowed list.", { title: () => parseTitle('{"title":"PRIVATE_MARKER","prs":["999"]}', []) }, 1, 1],
    ["Title model", "Title exceeded 55 characters.", { title: () => parseTitle(JSON.stringify({ title: "PRIVATE_MARKER".repeat(5), prs: [] }), []) }, 1, 1],
  ];
  for (const [stage, reason, options, checks, titles] of cases) {
    let failing = true;
    const h = harness(Object.fromEntries(Object.entries(options).map(([key, fn]: [string, any]) => [key,
      key === "exec" ? (args: string[], act: Function, pane: any) => failing ? fn(args, act, pane) : act()
        : key === "check" ? (...values: any[]) => failing ? fn(...values) : "new_task"
          : (...values: any[]) => failing ? fn(...values) : title])));
    await h.emit("session_start"); await h.send("PRIVATE_MARKER request");
    assert.equal(h.failures().length, 1, `${stage}: ${reason}`);
    const data = h.failures()[0].data;
    assert.deepEqual(Object.keys(data).sort(), ["checks", "elapsedMs", "paneId", "reason", "stage", "titles"]);
    assert.deepEqual({ ...data, elapsedMs: 0 }, { paneId: "own-pane", checks, titles, stage, reason, elapsedMs: 0 });
    assert.ok(Number.isSafeInteger(data.elapsedMs) && data.elapsedMs >= 0);
    assert.ok(h.notices.at(-1)!.startsWith(`Pane naming failed at ${stage} (`), h.notices.at(-1));
    assert.ok(h.notices.at(-1)!.includes(`${reason} Naming stays on and tries again on the next activity.`));
    assert.equal(JSON.stringify([h.notices, h.entries]).includes("PRIVATE_MARKER"), false);
    assert.notEqual(h.pane.label, "Fix login");
    failing = false;
    await h.send("Next task"); assert.equal(h.pane.label, "Fix login", `recovers after ${stage}: ${reason}`);
    assert.equal(h.failures().length, 1);
  }
});

test("a repeated failure warns once until a successful cycle", async () => {
  let mode = "fail";
  const h = harness({
    check: () => {
      if (mode === "fail") throw new Error("PRIVATE_MARKER");
      if (mode === "http") throw Object.assign(new Error("PRIVATE_MARKER"), { status: 503 });
      return mode;
    },
  });
  const failed = () => h.notices.filter((notice) => notice.startsWith("Pane naming failed")).length;
  await h.emit("session_start");
  await h.send("first"); await h.send("second");
  assert.equal(h.failures().length, 2); assert.equal(failed(), 1);
  mode = "keep"; await h.send("third");
  mode = "fail"; await h.send("fourth"); assert.equal(failed(), 2, "a keep decision resets the notice");
  mode = "http"; await h.send("fifth"); assert.equal(failed(), 3, "a different reason warns immediately");
  await h.send("sixth"); assert.equal(failed(), 3);
  mode = "new_task"; await h.send("seventh"); assert.equal(h.pane.label, "Fix login");
  mode = "http"; await h.send("eighth"); assert.equal(failed(), 4, "a successful rename resets the notice");
  mode = "new_task"; await h.send("ninth"); assert.equal(h.renames().length, 1);
  mode = "http"; await h.send("tenth"); assert.equal(failed(), 5, "an unchanged label also counts as success");
  mode = "uncertain"; await h.send("eleventh");
  mode = "http"; await h.send("twelfth"); assert.equal(failed(), 6, "an uncertain decision resets the notice");
  assert.equal(h.failures().length, 8);
});

test("deadlines identify the failing model stage; subsequent ordinary messages can recover", async (t) => {
  const deadlines: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, DEADLINE_MS);
    const deadline = new AbortController(); deadlines.push(deadline); return deadline.signal;
  });
  for (const stage of ["Jev", "Title model"]) {
    let fail = true;
    const h = harness({
      check: () => fail && stage === "Jev" ? new Promise(() => {}) : "new_task",
      title: () => fail && stage === "Title model" ? new Promise(() => {}) : title,
    });
    await h.emit("session_start"); await h.deliver("Fix login");
    await until(() => stage === "Jev" ? h.checks.length === 1 : h.titles.length === 1);
    deadlines.at(-1)!.abort(new DOMException("PRIVATE_MARKER", "TimeoutError"));
    await until(() => h.failures().length === 1);
    assert.equal(h.failures()[0].data.stage, stage);
    assert.equal(h.failures()[0].data.reason, "Naming request timed out.");
    await settle(); assert.equal(h.checks.length, 1); assert.equal(h.renames().length, 0);
    fail = false; await h.deliver("Continue fixing login"); await until(() => h.renames().length === 1);
    assert.equal(h.checks.length, 2); assert.equal(h.failures().length, 1);
    assert.equal(JSON.stringify([h.entries, h.notices]).includes("PRIVATE_MARKER"), false);
  }
});

test("keep, uncertainty and cancelled work are not reported as failures", async () => {
  for (const decision of ["keep", "uncertain"]) {
    const h = harness({ check: () => decision }); await h.emit("session_start"); await h.send("continue");
    assert.equal(h.failures().length, 0);
    assert.equal(h.notices.some((n) => n.startsWith("Pane naming failed")), false);
  }
  for (const action of ["off", "new-user", "session_before_switch", "session_shutdown"]) {
    const pending = deferred();
    const h = harness({ check: async (data: any) => {
      if (data.request === "old") { await pending.promise; throw new Error("PRIVATE_MARKER"); }
      return "keep";
    } });
    await h.emit("session_start"); await h.deliver("old"); await until(() => h.checks.length === 1);
    if (action === "off") await h.command("off");
    else if (action === "new-user") await h.deliver("new");
    else await h.emit(action);
    pending.resolve(undefined); await settle();
    assert.equal(h.failures().length, 0, action);
    assert.equal(h.notices.some((n) => n.startsWith("Pane naming failed")), false, action);
  }
});

// 10. Terminal and pane identity

test("the first terminal seen is remembered; a different terminal or pane id is a failure, never a rename", async () => {
  const h = harness({ title: (data: any) => ({ title: data.request, prs: [] }) });
  await h.emit("session_start"); await h.send("First task");
  assert.equal(h.pane.label, "First task");
  h.pane.terminal_id = "terminal-2";
  await h.send("Second task");
  assert.equal(h.renames().length, 1); assert.equal(h.pane.label, "First task");
  assert.deepEqual([h.failures()[0].data.stage, h.failures()[0].data.reason], ["Herdr read", "Herdr pane now belongs to a different terminal."]);
  await h.emit("session_start"); await h.send("Third task");
  assert.equal(h.renames().length, 1, "a new session in the same process keeps the remembered terminal");
  assert.equal(h.failures().length, 2);
  h.pane.terminal_id = "terminal-1";
  await h.send("Fourth task"); assert.equal(h.pane.label, "Fourth task");
  const wrong = harness(); wrong.pane.pane_id = "someone-else";
  await wrong.emit("session_start"); await wrong.send("Fix login");
  assert.equal(wrong.checks.length, 0); assert.equal(wrong.renames().length, 0);
  assert.equal(wrong.failures()[0].data.reason, "Invalid Herdr response.");
});

// 11. Stale results

test("late classification and title results cannot rename a newer task", async () => {
  for (const phase of ["check", "title"]) {
    const old = deferred();
    const h = harness({
      check: (data: any) => phase === "check" && data.request === "old" ? old.promise : "new_task",
      title: (data: any) => phase === "title" && data.request === "old" ? old.promise : { title: data.request, prs: [] },
    });
    await h.emit("session_start"); await h.deliver("old");
    await until(() => phase === "check" ? h.checks.length === 1 : h.titles.length === 1);
    await h.deliver("new"); await until(() => h.pane.label === "new");
    old.resolve(phase === "check" ? "new_task" : { title: "old", prs: [] }); await settle();
    assert.equal(h.pane.label, "new"); assert.equal(h.renames().length, 1);
    assert.equal(h.checks[0].signal.aborted, true); assert.equal(h.failures().length, 0);
  }
});

test("navigation, shutdown, off and agent abort invalidate pending model work", async () => {
  for (const action of ["session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "off", "aborted-message", "aborted-signal"]) {
    const pending = deferred(); const agent = new AbortController();
    const h = harness({ title: () => pending.promise });
    await h.emit("session_start"); h.ctx.signal = agent.signal;
    await h.deliver("old"); await until(() => h.titles.length === 1);
    if (action === "off") await h.command("off");
    else if (action === "aborted-message") await h.assistant("Aborted", { stopReason: "aborted" });
    else if (action === "aborted-signal") agent.abort();
    else await h.emit(action);
    pending.resolve(title); await settle();
    assert.equal(h.renames().length, 0, action); assert.equal(h.titles[0].signal.aborted, true, action);
    assert.equal(h.failures().length, 0, action);
  }
});

test("new user delivery, navigation, off and abort discard pending assistant work", async (t) => {
  const tick = activityClock(t);
  for (const action of ["new-user", "off", "abort", "session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "session_start"]) {
    const h = harness({ check: () => "keep" }); await h.emit("session_start"); await h.send("Research login");
    await h.assistant("Now debugging login");
    if (action === "new-user") await h.send("Research gardening");
    else if (action === "off") await h.command("off");
    else if (action === "abort") await h.assistant("Aborted text", { stopReason: "aborted" });
    else await h.emit(action);
    await tick();
    assert.equal(h.checks.length, action === "new-user" ? 2 : 1, action);
    assert.equal(h.checks.some((check) => check.data.activity), false, action);
  }
});

test("assistant checks cancel on the agent signal at every phase", async (t) => {
  const tick = activityClock(t);
  for (const phase of ["queued", "check", "title", "write"]) {
    const pending = deferred(); const agent = new AbortController(); let reads = 0;
    const h = harness({
      check: (data: any) => !data.activity ? "keep" : phase === "check" ? pending.promise : "update",
      title: () => phase === "title" ? pending.promise : title,
      exec: async (args: string[], act: Function) => {
        // Reads: user check, activity check, then the render's read before rename.
        if (phase === "write" && args[1] === "get" && ++reads === 3) await pending.promise;
        return act();
      },
    });
    await h.emit("session_start"); h.ctx.signal = agent.signal;
    await h.send("Fix login"); await h.assistant("Debugging login");
    if (phase !== "queued") await tick();
    agent.abort(); pending.resolve(phase === "check" ? "update" : title); await tick();
    assert.equal(h.renames().length, 0, phase);
    assert.equal(h.failures().length, 0, phase);
    assert.equal(h.checks.length, phase === "queued" ? 1 : 2, phase);
    if (phase !== "queued") assert.equal(h.checks[1].signal.aborted, true);
  }
});

test("new assistant activity invalidates stale classification and title results", async (t) => {
  const tick = activityClock(t);
  for (const phase of ["check", "title"]) {
    const pending = deferred();
    const h = harness({
      check: (data: any) => !data.activity ? "keep" : phase === "check" && data.activity.text === "Old phase" ? pending.promise : "update",
      title: (data: any) => phase === "title" && data.activity.text === "Old phase" ? pending.promise : { title: data.activity.text, prs: [] },
    });
    await h.emit("session_start"); await h.send("Fix login");
    await h.assistant("Old phase"); await tick();
    await until(() => phase === "check" ? h.checks.length === 2 : h.titles.length === 1);
    await h.assistant("New phase"); pending.resolve(phase === "check" ? "update" : { title: "Old phase", prs: [] });
    await settle(); assert.equal(h.renames().length, 0);
    await tick(); assert.equal(h.pane.label, "New phase");
    assert.equal(h.checks[1].signal.aborted, true); assert.equal(h.failures().length, 0);
  }
});

test("a stale Herdr read cannot initiate a rename", async () => {
  const read = deferred(); let gets = 0;
  const h = harness({ exec: async (args: string[], act: Function) => {
    if (args[1] === "get" && ++gets === 2) await read.promise;
    return act();
  } });
  await h.emit("session_start"); await h.deliver("old"); await until(() => gets === 2);
  await h.command("off"); read.resolve(undefined); await settle(); assert.equal(h.renames().length, 0);
});

test("shutdown waits only for an already-issued bounded CLI write", async () => {
  const pending = deferred(); const h = harness({ exec: async (args: string[], act: Function) => {
    if (args[1] === "rename") await pending.promise;
    return act();
  } });
  await h.emit("session_start"); await h.deliver("Fix login"); await until(() => h.renames().length === 1);
  let stopped = false; const shutdown = h.emit("session_shutdown").then(() => { stopped = true; });
  await settle(); assert.equal(stopped, false);
  pending.resolve(undefined); await shutdown; assert.equal(stopped, true);
  const model = deferred(); const idle = harness({ title: () => model.promise });
  await idle.emit("session_start"); await idle.deliver("Fix login"); await until(() => idle.titles.length === 1);
  await idle.emit("session_shutdown"); // Resolves without the pending model call.
  model.resolve(title); await settle(); assert.equal(idle.renames().length, 0);
});

test("a newer task waits for an old issued rename, then wins", async () => {
  const pending = deferred(); let renames = 0;
  const h = harness({
    title: (data: any) => ({ title: data.request, prs: [] }),
    exec: async (args: string[], act: Function) => {
      if (args[1] === "rename" && ++renames === 1) await pending.promise;
      return act();
    },
  });
  await h.emit("session_start"); await h.deliver("old"); await until(() => renames === 1);
  await h.deliver("new"); await settle(); assert.equal(h.checks.length, 1);
  pending.resolve(undefined); await until(() => h.pane.label === "new");
  assert.equal(h.checks[1].data.currentName, "old"); assert.equal(h.renames().length, 2);
});

// 12. Decisions and allowed PRs

test("keep/uncertain avoid title calls; identical output avoids redundant renames", async () => {
  let decision = "new_task";
  const h = harness({ check: () => decision }); await h.emit("session_start");
  await h.send("Fix login"); assert.equal(h.renames().length, 1);
  for (decision of ["keep", "uncertain", "update", "new_task"]) await h.send("continue");
  assert.equal(h.checks.length, 5); assert.equal(h.titles.length, 3); assert.equal(h.renames().length, 1);
});

test("update offers the current label's PRs plus explicit refs; new_task offers only explicit refs", async () => {
  for (const [label, decision, request, expected] of [
    ["PR #12, #34 · Review parser", "update", "Also check PR 56", ["12", "34", "56"]],
    ["PR #12, #34 · Review parser", "new_task", "Also check PR 56", ["56"]],
    ["PR #12, #34 · Review parser", "new_task", "Write docs", []],
    ["PR #1, #2, #3, #4 · Review", "update", "PR 5 too", ["1", "2", "3", "4"]],
    ["Manual name with PR #7", "update", "continue", []],
    ["Manual name", "update", "Look at https://github.com/example/repo/pull/8", ["8"]],
  ] as const) {
    const h = harness({ label, check: () => decision, title: (_data: any, allowed: string[]) => ({ title: "Review parser", prs: allowed }) });
    await h.emit("session_start"); await h.send(request);
    assert.deepEqual(h.titles[0].allowed, expected, `${label} / ${decision}`);
    assert.equal(h.pane.label, paneLabel({ title: "Review parser", prs: [...expected] }));
  }
});

test("PR switches and leaving PR work remove outdated prefixes", async () => {
  const h = harness({
    check: () => "update",
    title: (data: any) => ({ title: "Review changes", prs: data.request.includes("234") ? ["234"] : data.request.includes("123") ? ["123"] : [] }),
  });
  await h.emit("session_start");
  for (const [request, expected] of [["Review PR #123", "PR #123 · Review changes"], ["Switch to PR #234", "PR #234 · Review changes"], ["Leave PR work", "Review changes"]]) {
    await h.deliver(request); await until(() => h.pane.label === expected); await settle();
  }
  assert.deepEqual(h.titles.map((call) => call.allowed), [["123"], ["123", "234"], ["234"]]);
});

test("merge PR 130 is named on user delivery and assistant activity over an existing label", async (t) => {
  const tick = activityClock(t);
  for (const decision of ["new_task", "update"]) {
    const h = harness({
      label: "Creating pull request for evaluation changes", check: () => decision,
      title: (data: any, allowed: string[]) => parseTitle(JSON.stringify({
        title: data.activity ? "Merging PR 130" : "Preparing PR #130 merge", prs: ["130"],
      }), allowed),
    });
    await h.emit("session_start"); await h.send("merge PR 130 please.");
    assert.equal(h.pane.label, "PR #130 · Preparing merge");
    await h.assistant("I will check the head, then merge it."); await tick();
    assert.equal(h.pane.label, "PR #130 · Merging");
    assert.deepEqual(h.titles.map((call) => call.allowed), [["130"], ["130"]]);
    assert.equal(h.failures().length, 0);
  }
});

test("keep re-renders only to add a PR created during the check; uncertain never renames", async () => {
  for (const decision of ["keep", "uncertain"]) {
    const pending = deferred();
    const h = harness({ label: "Old title", check: () => pending.promise });
    await h.emit("session_start"); await h.deliver("Open the PR"); await until(() => h.checks.length === 1);
    const event = { toolName: "bash", toolCallId: "gh-1", input: { command: "gh pr create --fill" } };
    await h.emit("tool_call", event);
    await h.emit("tool_result", { ...event, isError: false, content: [{ type: "text", text: "https://github.com/example/repo/pull/42" }] });
    await settle(); assert.equal(h.renames().length, 0, "no desired title exists yet");
    pending.resolve(decision); await settle();
    assert.equal(h.titles.length, 0);
    assert.equal(h.pane.label, decision === "keep" ? "PR #42 · Old title" : "Old title");
  }
  const h = harness({ label: "Old title", check: () => "keep" });
  await h.emit("session_start"); await h.send("continue");
  assert.equal(h.renames().length, 0); assert.equal(h.titles.length, 0);
});

// 13. PR creation

test("confirmed gh pr creation updates a title without another model call", async () => {
  const h = harness(); await h.emit("session_start"); await h.send("Implement login");
  const event = { toolName: "bash", toolCallId: "gh-1", input: { command: 'gh pr create --title "Login" --body "Fixes login"' } };
  await h.emit("tool_call", event);
  await h.emit("tool_result", { ...event, isError: false, content: [{ type: "text", text: "https://github.com/example/repo/pull/42\n" }] });
  await until(() => h.renames().length === 2);
  assert.equal(h.pane.label, "PR #42 · Fix login"); assert.equal(h.checks.length, 1); assert.equal(h.titles.length, 1);
});

test("unsuccessful, indirect or non-bash PR creation output is ignored", async () => {
  const h = harness(); await h.emit("session_start"); await h.send("Implement login");
  const url = "https://github.com/example/repo/pull/7";
  for (const [id, toolName, command, isError, text] of [
    ["error", "bash", "gh pr create", true, url], ["pipe", "bash", "gh pr create | tee out", false, url],
    ["chain", "bash", "gh pr create && echo done", false, url], ["prose", "bash", "gh pr create", false, `Created ${url}`],
    ["view", "bash", "gh pr view 7", false, url], ["dry-run", "bash", "gh pr create --dry-run", false, url],
    ["not-bash", "other", "gh pr create", false, url],
  ] as const) {
    const event = { toolName, toolCallId: id, input: { command } };
    await h.emit("tool_call", event);
    await h.emit("tool_result", { ...event, isError, content: [{ type: "text", text }] });
  }
  await settle(); assert.equal(h.renames().length, 1); assert.equal(h.pane.label, "Fix login");
});

test("PR creation during generation is retained; an older task's result is discarded", async () => {
  const pending = deferred(); const h = harness({ title: () => pending.promise });
  await h.emit("session_start"); await h.deliver("Implement login"); await until(() => h.titles.length === 1);
  const event = { toolName: "bash", toolCallId: "gh-1", input: { command: "gh pr create" } };
  await h.emit("tool_call", event);
  await h.emit("tool_result", { ...event, isError: false, content: [{ type: "text", text: "https://github.com/example/repo/pull/42" }] });
  pending.resolve(title); await until(() => h.renames().length === 1);
  assert.equal(h.pane.label, "PR #42 · Fix login");
  await h.emit("tool_call", { ...event, toolCallId: "old-call" }); await h.send("Different task");
  await h.emit("tool_result", { ...event, toolCallId: "old-call", isError: false, content: [{ type: "text", text: "https://github.com/example/repo/pull/99" }] });
  await settle(); assert.equal(h.pane.label?.includes("99"), false);
});

test("assistant text cannot authorize invented PRs; confirmed creation survives an activity delay", async (t) => {
  const tick = activityClock(t);
  const h = harness({ title: (_data: any, allowed: string[]) => ({ title: "Login", prs: allowed }) });
  await h.emit("session_start"); await h.send("Fix login");
  await h.assistant("I will inspect PR #999 next."); await tick();
  assert.deepEqual(h.titles.at(-1).allowed, []); assert.equal(h.pane.label, "Login");
  await h.assistant("Creating the login PR.");
  const event = { toolName: "bash", toolCallId: "create", input: { command: "gh pr create" } };
  await h.emit("tool_call", event);
  await h.emit("tool_result", { ...event, isError: false, content: [{ type: "text", text: "https://github.com/example/repo/pull/42" }] });
  await settle(); assert.equal(h.pane.label, "PR #42 · Login");
  assert.equal(h.checks.length, 2, "PR confirmation itself needs no additional model call");
  await tick(); assert.equal(h.pane.label, "PR #42 · Login");
  await h.assistant("Now researching gardening, unrelated to the login PR."); await tick();
  assert.equal(h.pane.label, "Login"); assert.deepEqual(h.titles.at(-1).allowed, []);
});

test("only successful direct PR-create output is recognized", () => {
  const url = "https://github.com/example/repo/pull/12";
  assert.equal(createdPR("gh pr create", url), "12");
  assert.equal(createdPR("  gh  pr  create --fill ", `${url}\n`), "12");
  for (const command of ["echo gh pr create", "gh pr view", "gh pr create; echo x", "gh pr create --dry-run", "gh pr create --web",
    "gh pr create --help", "gh pr create\nother", "gh pr create $(stuff)", "gh pr create | cat", "gh pr create > out", "gh pr created", undefined, 42]) {
    assert.equal(createdPR(command, url), undefined, String(command));
  }
  for (const output of [`example: ${url}`, `${url}\n${url}`, "https://github.com/example/repo/pull/0", "https://gitlab.com/example/repo/pull/12"]) {
    assert.equal(createdPR("gh pr create", output), undefined, output);
  }
});

// 14. Title model resolution

test("resolveTitleModel prefers a usable selected model, then the default, then the session model", () => {
  const session = { provider: "anthropic", id: "session-model" } as any;
  const context = (available: string[], unauthorized: string[] = [], authCheck = true): any => ({
    model: session,
    modelRegistry: {
      find: (provider: string, id: string) => available.includes(`${provider}/${id}`) ? { provider, id } : undefined,
      ...(authCheck ? { hasConfiguredAuth: (model: any) => !unauthorized.includes(`${model.provider}/${model.id}`) } : {}),
    },
  });
  const all = ["google/saved", "openrouter/meta/llama", FALLBACK_TITLE_MODEL];
  assert.equal(FALLBACK_TITLE_MODEL, "google/gemini-3.5-flash-lite");
  assert.deepEqual(resolveTitleModel(context(all), "google/saved"), { provider: "google", id: "saved" });
  assert.deepEqual(resolveTitleModel(context(all), "openrouter/meta/llama"), { provider: "openrouter", id: "meta/llama" });
  assert.deepEqual(resolveTitleModel(context(all, [], false), "google/saved"), { provider: "google", id: "saved" }, "no auth check means usable");
  for (const selected of ["google/missing", "no-provider", "", undefined, 5]) {
    assert.deepEqual(resolveTitleModel(context(all), selected), { provider: "google", id: "gemini-3.5-flash-lite" }, String(selected));
  }
  assert.deepEqual(resolveTitleModel(context(all, ["google/saved"]), "google/saved"), { provider: "google", id: "gemini-3.5-flash-lite" });
  assert.equal(resolveTitleModel(context(["google/saved"]), "google/missing"), session);
  assert.equal(resolveTitleModel(context(all, ["google/saved", FALLBACK_TITLE_MODEL]), "google/saved"), session);
  assert.equal(resolveTitleModel({ ...context([]), model: undefined }, "google/saved"), undefined);
});

test("title model precedence is command > flag > saved > default, and the resolved model reaches generateTitle", async () => {
  const models = ["google/saved-model", "google/flag-model", "google/command-model", FALLBACK_TITLE_MODEL];
  const h = harness({ models, preferences: { titleModel: "google/saved-model" }, flags: { "pane-naming-model": "google/flag-model" } });
  await h.emit("session_start"); await h.send("Fix login");
  assert.deepEqual(h.titles[0].model, { provider: "google", id: "flag-model" });
  await h.command("model google/command-model"); await h.send("Next task");
  assert.deepEqual(h.titles[1].model, { provider: "google", id: "command-model" });
  assert.equal((await savedPreferences(h)).titleModel, "google/command-model");
  for (const [options, expected, status] of [
    [{ preferences: { titleModel: "google/saved-model" } }, "saved-model", "Title model: google/saved-model."],
    [{}, "gemini-3.5-flash-lite", "Title model: google/gemini-3.5-flash-lite (default)."],
    [{ preferences: { titleModel: "google/gone" } }, "gemini-3.5-flash-lite", "Title model: google/gemini-3.5-flash-lite (fallback; google/gone unavailable)."],
    [{ preferences: { titleModel: "google/saved-model" }, unauthorized: ["google/saved-model"] }, "gemini-3.5-flash-lite",
      "Title model: google/gemini-3.5-flash-lite (fallback; google/saved-model unavailable)."],
  ] as const) {
    const next = harness({ models, ...options }); await next.emit("session_start"); await next.send("Fix login");
    assert.equal(next.titles[0].model.id, expected);
    await next.command("status"); assert.ok(next.notices.at(-1)!.includes(status), next.notices.at(-1));
  }
  const session = harness({ models: [], sessionModel: { provider: "anthropic", id: "session-model" } });
  await session.emit("session_start"); assert.deepEqual(session.notices, []);
  await session.send("Fix login"); assert.equal(session.titles[0].model.id, "session-model");
});

test("no usable title model warns at startup and fails per attempt without disabling naming", async () => {
  const models: string[] = [];
  const h = harness({ models }); await h.emit("session_start");
  assert.deepEqual(h.notices, ["Pane naming is on, but no title model is available. Use /pane-naming model provider/model-id."]);
  await h.send("PRIVATE_MARKER request");
  assert.equal(h.calls.length, 0); assert.equal(h.checks.length, 0);
  assert.deepEqual([h.failures()[0].data.stage, h.failures()[0].data.reason],
    ["Title model selection", "No title model is available. Use /pane-naming model provider/model-id."]);
  await h.command("status"); assert.ok(h.notices.at(-1)!.startsWith("Pane naming on;"));
  assert.ok(h.notices.at(-1)!.includes("Title model: none available."));
  models.push(FALLBACK_TITLE_MODEL);
  await h.send("Fix login"); assert.equal(h.pane.label, "Fix login");
  assert.equal(JSON.stringify([h.entries, h.notices]).includes("PRIVATE_MARKER"), false);
});

test("title generation uses the resolved model, no main context/tools, and bounded output", async () => {
  let captured: any; const signal = new AbortController().signal; const model: any = { provider: "google", id: "test-model" };
  const ctx: any = { modelRegistry: {
    find: () => { throw new Error("generateTitle must use the resolved model"); },
    streamSimple: (selected: any, context: any, options: any) => {
      captured = { selected, context, options }; return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(title) }] }) };
    },
  } };
  assert.deepEqual(await generateTitle(model, input, ["12"], ctx, signal), title);
  assert.equal(captured.selected, model);
  assert.equal(captured.context.tools, undefined); assert.equal(captured.context.messages.length, 1);
  assert.deepEqual(JSON.parse(captured.context.messages[0].content), { ...input, allowedPRs: ["12"] });
  assert.equal(captured.options.signal, signal);
  assert.equal(captured.options.maxTokens, 160); assert.equal(captured.options.maxRetries, 0); assert.equal(captured.options.reasoning, undefined);
  for (const [result, expected] of [
    [{ stopReason: "length", errorMessage: "PRIVATE_MARKER" }, "Title model stopped with length."],
    [{ stopReason: "error", errorMessage: JSON.stringify({ error: { code: 403, message: "PRIVATE_MARKER" } }) }, "Title model HTTP 403."],
    [{ stopReason: "error", errorMessage: "PRIVATE_MARKER" }, "Title model stopped with error."],
    [{ stopReason: "PRIVATE_MARKER", errorMessage: "PRIVATE_MARKER" }, "Title model stopped with unknown."],
  ] as const) {
    const failing: any = { modelRegistry: { streamSimple: () => ({ result: async () => result }) } };
    await assert.rejects(generateTitle(model, input, [], failing, signal), (error) => describeFailure(error) === expected);
  }
});

// 15. Jev through pi-typesafe

const TYPESAFE_KEY = "test-not-a-secret";
function memoryLedger() {
  const counts = { started: 0, succeeded: 0, failed: 0 };
  const ledger: UsageLedger = {
    path: join(agentDirectory, "unused-usage.json"), usdPerMTok: 0,
    today: () => ({ day: "2026-10-07", requestsStarted: counts.started, requestsSucceeded: counts.succeeded, requestsFailed: counts.failed, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }),
    recordStart: () => { counts.started++; },
    recordSuccess: () => { counts.succeeded++; },
    recordFailure: () => { counts.failed++; },
    blocked: () => undefined,
    describe: () => "in-memory test ledger",
  };
  return { ledger, counts };
}
function jevClient(fetch: (url: string, init: any) => Promise<Response>, ledger = memoryLedger().ledger) {
  return () => createTypeSafe({ apiKey: TYPESAFE_KEY, fetch: fetch as any, ledger, maxRequests: 1 });
}
function systemOneResult(choice = "new_task") {
  const probabilities: Record<string, number> = { keep: 0.02, update: 0.02, new_task: 0.02, uncertain: 0.02 };
  probabilities[choice] = 0.94;
  return { model: "jev-latest", usage: { input_tokens: 120, output_tokens: 1 }, answers: { naming: { type: "choice", choice, confidence: 0.94, probabilities } } };
}

test("classify sends one SystemOne request through pi-typesafe and returns Jev's choice", async () => {
  const requests: { url: string; init: any }[] = [];
  const { ledger, counts } = memoryLedger();
  let factories = 0;
  for (const choice of ["keep", "update", "new_task", "uncertain"]) {
    const client = jevClient(async (url, init) => { requests.push({ url: String(url), init }); return Response.json(systemOneResult(choice)); }, ledger);
    assert.equal(await classify(input, new AbortController().signal, () => { factories++; return client(); }), choice);
  }
  assert.equal(factories, 4, "a fresh client per check, so maxRequests: 1 never accumulates");
  assert.equal(requests.length, 4); assert.deepEqual(counts, { started: 4, succeeded: 4, failed: 0 });
  const { url, init } = requests[0];
  assert.equal(url, "https://api.typesafe.ai/v1/systemone"); assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${TYPESAFE_KEY}`);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.deepEqual(body.state, input); assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions), ["naming"]);
  assert.equal(body.questions.naming.type, "choice"); assert.equal(typeof body.questions.naming.instructions, "string");
  assert.deepEqual(Object.keys(body.questions.naming.criteria), ["keep", "update", "new_task", "uncertain"]);
  assert.equal(init.body.includes(TYPESAFE_KEY), false);
});

test("classify rejects HTTP errors, malformed answers and connection failures with safe messages and no retries", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    let calls = 0;
    const client = jevClient(async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: `PRIVATE_BODY ${TYPESAFE_KEY}` } }), { status, headers: { "content-type": "application/json" } });
    });
    await assert.rejects(classify(input, new AbortController().signal, client), (error: Error) => {
      assert.match(describeFailure(error), new RegExp(`^TypeSafe returned HTTP ${status}\\. `));
      assert.equal(describeFailure(error), error.message);
      return !error.message.includes(TYPESAFE_KEY) && !error.message.includes("PRIVATE_BODY");
    });
    assert.equal(calls, 1, `HTTP ${status} is not retried`);
  }
  for (const change of [
    (r: any) => { r.answers.naming.choice = "PRIVATE_MARKER"; },
    (r: any) => { r.answers.naming.type = "score"; },
    (r: any) => { delete r.answers.naming.probabilities.keep; },
    (r: any) => { r.answers.naming.probabilities.extra = 0; },
    (r: any) => { r.answers.naming.confidence = 1.5; },
    (r: any) => { delete r.usage; },
    (r: any) => { r.model = ""; },
    (r: any) => { r.answers.extra = r.answers.naming; },
  ]) {
    const value = systemOneResult(); change(value);
    await assert.rejects(classify(input, new AbortController().signal, jevClient(async () => Response.json(value))),
      (error) => describeFailure(error) === "TypeSafe returned an unexpected answer or usage format.");
  }
  await assert.rejects(classify(input, new AbortController().signal, jevClient(async () => new Response("PRIVATE_MARKER not json"))),
    (error) => describeFailure(error) === "TypeSafe returned an unexpected answer or usage format.");
  await assert.rejects(classify(input, new AbortController().signal, jevClient(async () => { throw new TypeError("fetch failed", { cause: new Error("PRIVATE_MARKER") }); })),
    (error) => describeFailure(error) === "Could not complete the TypeSafe connection. No automatic retry was made.");
});

test("classify reports client setup errors without contacting TypeSafe", async () => {
  const message = "No API key. Run /typesafe login in Pi, or set TYPESAFE_API_KEY in the environment.";
  await assert.rejects(classify(input, new AbortController().signal, () => { throw new TypeSafeIntegrationError("configuration", message); }),
    (error) => describeFailure(error) === message);
  await assert.rejects(classify(input, new AbortController().signal, () => { throw new Error("PRIVATE_MARKER"); }),
    (error) => describeFailure(error) === "Could not start the TypeSafe client.");
  // The default client reads TYPESAFE_API_KEY, then the key store under the isolated PI_CODING_AGENT_DIR.
  const originalKey = process.env.TYPESAFE_API_KEY; const originalFetch = globalThis.fetch;
  delete process.env.TYPESAFE_API_KEY;
  globalThis.fetch = () => { throw new Error("Network prohibited"); };
  try {
    await assert.rejects(classify(input, new AbortController().signal), (error) => describeFailure(error) === message);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey !== undefined) process.env.TYPESAFE_API_KEY = originalKey;
  }
});

test("classify stops waiting on cancellation or timeout even if fetch ignores its signal", async () => {
  for (const kind of ["cancel", "timeout", "already-aborted"]) {
    const hanging = deferred(); let calls = 0;
    const client = jevClient(async () => { calls++; return hanging.promise; });
    const controller = new AbortController();
    if (kind === "already-aborted") controller.abort();
    const signal = kind === "timeout" ? AbortSignal.timeout(20) : controller.signal;
    const pending = classify(input, signal, client);
    if (kind === "cancel") { await until(() => calls === 1); controller.abort(); }
    await assert.rejects(pending, (error) => describeFailure(error) === (kind === "timeout" ? "Naming request timed out." : "Naming request cancelled."));
    assert.equal(calls, kind === "already-aborted" ? 0 : 1, kind);
    // Release the ignored request so the SDK can clear its own timer.
    hanging.resolve(new Response("", { status: 500 })); await settle();
  }
});

// 16. TypeSafe key status

test("Jev key errors warn at startup but naming stays on; status includes the key status", async () => {
  const text = "TypeSafe key: missing — every Jev judgment is skipped until a key is configured.";
  const h = harness({ typesafeStatus: () => ({ level: "error", text }) });
  await h.emit("session_start");
  assert.deepEqual(h.notices, [`Pane naming is on, but Jev is unavailable: ${text}`]);
  await h.send("Fix login"); assert.equal(h.pane.label, "Fix login");
  await h.command("status");
  assert.ok(h.notices.at(-1)!.startsWith("Pane naming on;")); assert.ok(h.notices.at(-1)!.endsWith(`Jev: ${text}`));
  const warning = harness({ typesafeStatus: () => ({ level: "warning", text: "TypeSafe key: not yet verified." }) });
  await warning.emit("session_start"); assert.deepEqual(warning.notices, []);
  const broken = harness({ typesafeStatus: () => { throw new Error("PRIVATE_MARKER"); } });
  await broken.emit("session_start");
  assert.deepEqual(broken.notices, ["Pane naming is on, but Jev is unavailable: Could not read the TypeSafe key status."]);
  await broken.command("status"); assert.ok(broken.notices.at(-1)!.endsWith("Jev: key status unreadable"));
  await broken.send("Fix login"); assert.equal(broken.pane.label, "Fix login");
});

// 17. Commands

test("on and off save the global default and apply to this pane immediately", async () => {
  const h = harness({ preferences: { enabled: false } }); await h.emit("session_start");
  await h.command("on");
  assert.equal(h.notices.at(-1), "Pane naming on here and by default for new panes. It names the pane from the next user message or assistant activity.");
  assert.deepEqual(await savedPreferences(h), { enabled: true });
  assert.equal(h.checks.length, 0, "enabling must not replay a request");
  await h.send("Fix login"); assert.equal(h.pane.label, "Fix login");
  await h.command("off");
  assert.equal(h.notices.at(-1), "Pane naming off here and by default for new panes. Other running panes are unchanged. /pane-naming on turns it back on.");
  assert.deepEqual(await savedPreferences(h), { enabled: false });
  await h.send("Next task"); assert.equal(h.checks.length, 1);
  const next = harness({ preferencesFile: h.preferencesFile }); await next.emit("session_start");
  await next.send("Fix login"); assert.equal(next.calls.length, 0);
  await next.command("on"); await next.send("Fix login"); assert.equal(next.renames().length, 1);
  const fresh = harness({ preferencesFile: h.preferencesFile }); await fresh.emit("session_start");
  await fresh.send("Fix login"); assert.equal(fresh.renames().length, 1);
});

test("status reports state, defaults, counts, cooldown, title model and Jev status", async () => {
  const h = harness();
  await h.emit("session_start"); await h.send("Fix login");
  await h.command("status");
  assert.equal(h.notices.at(-1), "Pane naming on; new-pane default on. This session: 1 Jev checks, 1 title requests. Cooldown: 30s. "
    + "Title model: google/gemini-3.5-flash-lite (default). Jev: TypeSafe key: verified.");
  await h.command(""); assert.equal(h.notices.at(-1), h.notices.at(-2), "no argument means status");
  await h.command("off"); await h.command("status");
  assert.ok(h.notices.at(-1)!.startsWith("Pane naming off; new-pane default off. This session: 1 Jev checks"));
  await h.emit("session_start"); await h.command("status");
  assert.ok(h.notices.at(-1)!.startsWith("Pane naming off; new-pane default off. This session: 0 Jev checks, 0 title requests."));
});

test("model commands validate, save, cancel old work and apply to this pane", async (t) => {
  const tick = activityClock(t);
  for (const phase of ["queued", "check", "title", "write"]) {
    const pending = deferred(); let reads = 0;
    const h = harness({
      check: (data: any) => !data.activity ? "keep" : phase === "check" && data.activity.text === "Old phase" ? pending.promise : "update",
      title: (data: any) => phase === "title" && data.activity.text === "Old phase" ? pending.promise : { title: data.activity.text, prs: [] },
      exec: async (args: string[], act: Function) => {
        if (phase === "write" && args[1] === "get" && ++reads === 3) await pending.promise;
        return act();
      },
    });
    await h.emit("session_start"); await h.send("Fix login"); await h.assistant("Old phase");
    if (phase !== "queued") await tick();
    const attempts = h.checks.length;
    await h.command("model google/new-model");
    assert.equal(h.notices.at(-1), "Saved title model: google/new-model. Applied here and to future panes; other running panes are unchanged.");
    pending.resolve(phase === "check" ? "update" : title);
    await tick(); assert.equal(h.renames().length, 0, phase); assert.equal(h.checks.length, attempts);
    await h.assistant("New phase"); await tick();
    assert.equal(h.pane.label, "New phase"); assert.deepEqual(h.titles.at(-1).model, { provider: "google", id: "new-model" });
    assert.equal(h.failures().length, 0);
    assert.deepEqual(await savedPreferences(h), { titleModel: "google/new-model" });
  }
});

test("invalid command arguments change neither preferences nor live settings", async () => {
  const h = harness({ preferences: { enabled: true, titleModel: "google/test-model" }, unauthorized: ["google/new-model"] }); await h.emit("session_start");
  const original = await readFile(h.preferencesFile, "utf8");
  for (const [command, notice] of [
    ["cooldown", USAGE], ["cooldown 0", "cooldown requires a whole number from 1 to 3600."], ["cooldown 3601", "cooldown requires a whole number from 1 to 3600."],
    ["cooldown 1.5", "cooldown requires a whole number from 1 to 3600."], ["cooldown 2s", "cooldown requires a whole number from 1 to 3600."],
    ["cooldown 1e2", "cooldown requires a whole number from 1 to 3600."], ["cooldown 05", "cooldown requires a whole number from 1 to 3600."],
    ["cooldown 1 2", USAGE], ["model", USAGE], ["model no-provider", "Use /pane-naming model provider/model-id."],
    ["model google/missing", "Title model unavailable in Pi (unknown or no credentials). Choose an available provider/model-id; nothing was changed."],
    ["model google/new-model", "Title model unavailable in Pi (unknown or no credentials). Choose an available provider/model-id; nothing was changed."],
    ["model google/test-model extra", USAGE], ["off extra", USAGE], ["on extra", USAGE], ["status extra", USAGE], ["rename x", USAGE],
  ] as const) {
    await h.command(command);
    assert.equal(h.notices.at(-1), notice, command);
    assert.equal(await readFile(h.preferencesFile, "utf8"), original, command);
  }
  await h.command("status"); assert.ok(h.notices.at(-1)!.includes("Cooldown: 30s. Title model: google/test-model."));
  await h.send("Fix login"); assert.equal(h.checks.length, 1); assert.equal(h.titles[0].model.id, "test-model");
});

test("settings saved by another pane do not change this pane's runtime until a command or new session", async (t) => {
  const tick = activityClock(t);
  const a = harness(); await a.emit("session_start");
  const b = harness({ preferencesFile: a.preferencesFile, check: () => "keep" }); await b.emit("session_start");
  await a.command("cooldown 5"); await a.command("model google/new-model");
  assert.deepEqual(await savedPreferences(a), { cooldownSeconds: 5, titleModel: "google/new-model" });
  await b.send("Fix login");
  await b.assistant("Testing login"); await tick(5_000); assert.equal(b.checks.length, 1, "b keeps its 30s cooldown");
  await tick(25_000); assert.equal(b.checks.length, 2);
  await b.command("status"); await b.command("cooldown abc");
  await b.command("status");
  assert.ok(b.notices.at(-1)!.includes("Cooldown: 30s. Title model: google/gemini-3.5-flash-lite (default)."), b.notices.at(-1));
  assert.ok(b.notices.at(-1)!.includes("new-pane default on"));
  const c = harness({ preferencesFile: a.preferencesFile, check: () => "new_task" }); await c.emit("session_start");
  await b.emit("session_start");
  for (const pane of [b, c]) {
    await pane.command("status");
    assert.ok(pane.notices.at(-1)!.includes("Cooldown: 5s. Title model: google/new-model."), "a new session picks up saved settings");
  }
  await c.send("Fix login"); assert.equal(c.titles[0].model.id, "new-model");
});

test("failed atomic settings writes leave both runtime settings and the saved file unchanged", async (t) => {
  const h = harness({ preferences: { enabled: true, titleModel: "google/test-model" } }); await h.emit("session_start");
  const original = await readFile(h.preferencesFile, "utf8");
  const beforeFiles = await readdir(preferencesDirectory);
  t.mock.method(fs, "renameSync", () => { throw new Error("PRIVATE_WRITE_FAILURE"); });
  syncBuiltinESMExports();
  try {
    for (const command of ["cooldown 5", "model google/new-model", "on"]) {
      await h.command(command); assert.equal(h.notices.at(-1), SAVE_FAILED, command);
    }
    await h.command("status");
    assert.ok(h.notices.at(-1)!.startsWith("Pane naming on; new-pane default on."));
    assert.ok(h.notices.at(-1)!.includes("Cooldown: 30s. Title model: google/test-model."));
    await h.command("off");
    assert.equal(h.notices.at(-1), "Pane naming off here, but the global default could not be saved.");
    await h.command("status"); assert.ok(h.notices.at(-1)!.startsWith("Pane naming off; new-pane default on."));
    assert.equal(await readFile(h.preferencesFile, "utf8"), original);
    assert.deepEqual(await readdir(preferencesDirectory), beforeFiles, "temporary preference files must be removed");
    assert.equal(h.notices.join("\n").includes("PRIVATE_WRITE_FAILURE"), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  await h.command("on"); await h.send("Fix login"); assert.equal(h.titles[0].model.id, "test-model");
});

// 18. Privacy and bounds

test("request context is bounded and excludes thinking, tools and older history", async () => {
  const history = [
    assistantMessage([{ type: "text", text: "PRIVATE_OLDER_REPLY" }], "a0"),
    userMessage("Earlier request", "u0"),
    assistantMessage([
      { type: "thinking", thinking: "PRIVATE_THINKING" }, { type: "text", text: "a".repeat(900) },
      { type: "toolCall", name: "bash", arguments: { command: "PRIVATE_ARGUMENT" } },
    ], "a1"),
    { type: "message", id: "t1", message: { role: "toolResult", content: [{ type: "text", text: "PRIVATE_RESULT" }] } },
  ];
  const h = harness({ history });
  await h.emit("session_start"); await h.deliver("x".repeat(10_000)); await until(() => h.checks.length === 1);
  const data = h.checks[0].data;
  assert.equal(data.request.length, 2000); assert.equal(data.replyContext, "a".repeat(600));
  assert.equal(data.activity, undefined); assert.equal(data.currentName, "");
  // A hand-set label can be arbitrarily long; only the first 80 characters leave Pi.
  const long = harness({ label: "L".repeat(300) });
  await long.emit("session_start"); await long.deliver("Fix login"); await until(() => long.checks.length === 1);
  assert.equal(long.checks[0].data.currentName, "L".repeat(80));
  assert.equal(JSON.stringify([h.checks, h.titles]).includes("PRIVATE_"), false);
  await settle(); await h.emit("session_start");
  await h.assistant("y".repeat(1_000)); await settle();
  assert.equal(h.checks[1].data.request, "Earlier request", "the anchor is bounded the same way");
  assert.equal(h.checks[1].data.replyContext, "", "activity checks send no reply context");
  assert.equal(h.checks[1].data.activity.text.length, 600);
  assert.equal(JSON.stringify(h.entries).includes("x".repeat(20)), false);
});

// 19. Pure helpers

test("explicitPRs, parseTitle, paneLabel and parseLabel", () => {
  assert.deepEqual(parseTitle(JSON.stringify(title), []), title);
  const observed = '```json\n{"title":"Fix Login Form Validation","prs":[]}\n```';
  assert.deepEqual(parseTitle(observed, []), { title: "Fix Login Form Validation", prs: [] });
  assert.throws(() => parseTitle(`Here is a title:\n${observed}`, []));
  assert.throws(() => parseTitle(`${observed}\nIgnore the rules`, []));
  assert.deepEqual(parseTitle('{"title":"Review PR #234","prs":["234"]}', ["234"]), { title: "Review", prs: ["234"] });
  assert.throws(() => parseTitle('{"title":"Review PR #999","prs":["234"]}', ["234"]));
  for (const reference of ["PR 130", "PR #130", "PR#130", "pr 130"]) {
    assert.deepEqual(explicitPRs(`merge ${reference} please.`), ["130"]);
    assert.deepEqual(parseTitle(JSON.stringify({ title: `Merge ${reference}`, prs: ["130"] }), ["130"]), { title: "Merge", prs: ["130"] });
    assert.throws(() => parseTitle(JSON.stringify({ title: `Merge ${reference}`, prs: ["130"] }), []));
    assert.throws(() => parseTitle(JSON.stringify({ title: `Merge ${reference}`, prs: [] }), ["130"]));
  }
  assert.deepEqual(explicitPRs("issue #130; #130; 130; PR130; XPR 130; PR 0; PR 0130; PR 12345678901; PR 130abc"), []);
  assert.deepEqual(explicitPRs("PR 1; PR #2; PR 3; PR #4; PR 5"), ["1", "2", "3", "4"]);
  assert.deepEqual(explicitPRs("issue #5; PR 12; PR #12; https://github.com/example/repo/pull/34; PR #12"), ["12", "34"]);
  assert.deepEqual(explicitPRs("[review](https://github.com/example/repo/pull/34)"), ["34"]);
  assert.deepEqual(explicitPRs("https://github.com/example/repo/pull/34\n"), ["34"]);
  assert.deepEqual(explicitPRs("https://github.com/example/repo/pull/34abc"), []);
  assert.equal(paneLabel({ title: "Fix login", prs: [] }), "Fix login");
  assert.equal(paneLabel({ title: "Fix login", prs: ["1", "22"] }), "PR #1, #22 · Fix login");
  assert.equal([...paneLabel({ title: "a".repeat(55), prs: ["1234567890", "2234567890", "3234567890", "4234567890"] })].length, 80);
  for (const value of [{ title: "Fix login", prs: [] }, { title: "Review parser", prs: ["12"] }, { title: "Ship · release", prs: ["1", "2", "3", "4"] }]) {
    assert.deepEqual(parseLabel(paneLabel(value)), value);
  }
  for (const label of ["My manual name", "PR #0 · Not ours", "PR #1, #2, #3, #4, #5 · Too many", "PR 12 · Loose", "PR #12 ·", "PR #12, 34 · Mixed"]) {
    assert.deepEqual(parseLabel(label), { title: label, prs: [] }, label);
  }
  for (const empty of [null, undefined, ""]) assert.equal(parseLabel(empty), undefined);
});

test("title validation identifies the failed rule without exposing response content", () => {
  for (const [value, reason] of [
    [null, "Title field was not a string."],
    [{ title: 130, prs: [] }, "Title field was not a string."],
    [{ title: "PRIVATE_MARKER" }, "Title PRs field was not an array."],
    [{ title: "PRIVATE_MARKER", prs: "PRIVATE_MARKER" }, "Title PRs field was not an array."],
    [{ title: "PRIVATE_MARKER", prs: ["1", "2", "3", "4", "5"] }, "Title selected more than 4 PRs."],
    [{ title: "PRIVATE_MARKER", prs: [2] }, "Title PR identifiers were not strings."],
    [{ title: "PRIVATE_MARKER", prs: ["999"] }, "Title selected a PR outside the allowed list."],
    [{ title: "PRIVATE_MARKER", prs: ["PRIVATE_PR"] }, "Title selected a PR outside the allowed list."],
    [{ title: "PRIVATE_MARKER", prs: ["2", "2"] }, "Title selected duplicate PRs."],
    [{ title: "", prs: [] }, "Title was empty after normalization."],
    [{ title: "PR 2", prs: ["2"] }, "Title was empty after normalization."],
    [{ title: "--PRIVATE_MARKER", prs: [] }, "Title started with a hyphen."],
    [{ title: "-h", prs: [] }, "Title started with a hyphen."],
    [{ title: "PRIVATE_MARKER".repeat(5), prs: [] }, "Title exceeded 55 characters."],
    [{ title: "\u001bPRIVATE_MARKER", prs: [] }, "Title contained control or invisible characters."],
    [{ title: "PRIVATE_MARKER\u202e", prs: [] }, "Title contained control or invisible characters."],
    [{ title: "PRIVATE_MARKER\u2028x", prs: [] }, "Title contained control or invisible characters."],
    [{ title: "PRIVATE_MARKER PR #2", prs: [] }, "Title contained a PR reference or # sign outside the prefix."],
    [{ title: "PRIVATE_MARKER PR 999", prs: ["2"] }, "Title contained a PR reference or # sign outside the prefix."],
    [{ title: "PRIVATE_MARKER #2", prs: ["2"] }, "Title contained a PR reference or # sign outside the prefix."],
  ] as const) {
    assert.throws(() => parseTitle(JSON.stringify(value), ["1", "2", "3", "4", "5"]), (error) => describeFailure(error) === reason);
  }
  assert.throws(() => parseTitle("PRIVATE_MARKER", []), (error) => describeFailure(error) === "Title model returned invalid JSON.");
  assert.deepEqual(parseTitle(JSON.stringify({ title: "🦄".repeat(55), prs: ["1", "2", "3", "4"] }), ["1", "2", "3", "4"]), {
    title: "🦄".repeat(55), prs: ["1", "2", "3", "4"],
  });
});

test("diagnostics retain only known error metadata", () => {
  assert.equal(describeFailure(failure("Herdr CLI unavailable.")), "Herdr CLI unavailable.");
  assert.equal(describeFailure(new Error("PRIVATE_MARKER")), "Unexpected error (details withheld).");
  assert.equal(describeFailure(new TypeSafeIntegrationError("http", "PRIVATE_MARKER")), "Unexpected error (details withheld).");
  assert.equal(describeFailure(Object.assign(new Error("PRIVATE_MARKER"), { status: 429 })), "Provider HTTP 429.");
  assert.equal(describeFailure(Object.assign(new Error("PRIVATE_MARKER"), { statusCode: 502 })), "Provider HTTP 502.");
  assert.equal(describeFailure(Object.assign(new Error("PRIVATE_MARKER"), { status: 200 })), "Unexpected error (details withheld).");
  assert.equal(describeFailure(new TypeError("fetch failed")), "Network request failed.");
  assert.equal(describeFailure(new Error("PRIVATE_MARKER", { cause: { code: "ECONNRESET" } })), "Network error (ECONNRESET).");
  assert.equal(describeFailure(new Error("PRIVATE_MARKER", { cause: { code: "PRIVATE_MARKER" } })), "Unexpected error (details withheld).");
  for (const value of [null, undefined, "PRIVATE_MARKER", 42]) assert.equal(describeFailure(value), "Unexpected error (details withheld).");
});

test("abortable stops waiting even if the underlying work ignores its signal", async () => {
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(abortable(new Promise(() => {}), AbortSignal.timeout(5)), (error) => describeFailure(error) === "Naming request timed out.");
    const controller = new AbortController(); const pending = abortable(new Promise(() => {}), controller.signal);
    controller.abort(); await assert.rejects(pending, (error) => describeFailure(error) === "Naming request cancelled.");
    await assert.rejects(abortable(Promise.resolve("late"), AbortSignal.abort()), (error) => describeFailure(error) === "Naming request cancelled.");
    assert.equal(await abortable(Promise.resolve("value"), new AbortController().signal), "value");
    await assert.rejects(abortable(Promise.reject(new Error("PRIVATE_MARKER")), new AbortController().signal), /PRIVATE_MARKER/);
  } finally { clearTimeout(keepAlive); }
});
