import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";
import fs, { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createdPR, eligible, register } from "../index.ts";
import { abortable, classify, configuration, DEADLINE_MS, describeFailure, explicitPRs, generateTitle, DEFAULT_CHECK_LIMIT, paneLabel, parseDecision, parseTitle } from "../models.ts";

const preferencesDirectory = mkdtempSync(join(tmpdir(), "pane-naming-preferences-"));
let harnessId = 0;
after(() => rm(preferencesDirectory, { recursive: true, force: true }));
const credentials = { accountId: "a".repeat(32), apiToken: "test-not-a-secret" };
const env = { HERDR_ENV: "1", HERDR_PANE_ID: "own-pane", CLOUDFLARE_JEV_API_CREDENTIALS_FILE: join(tmpdir(), "unused-jev-credentials.json") };
const title = { title: "Fix login", prs: [] };
const input = { request: "Fix login", previousTask: "", currentName: "", replyContext: "" };
const config = configuration(env, "google/test-model");
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

function harness(options: any = {}) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, Function>();
  const flags: any = { "pane-naming": options.on ?? true, "pane-naming-model": "google/test-model", ...options.flags };
  const preferencesFile = options.preferencesFile ?? join(preferencesDirectory, `${++harnessId}.json`);
  const entries: any[] = options.entries ?? [];
  const calls: any[] = [], checks: any[] = [], titles: any[] = [], notices: string[] = [];
  const paneId = options.env?.HERDR_PANE_ID ?? env.HERDR_PANE_ID;
  const pane: any = { pane_id: paneId, terminal_id: "terminal-1", ...(options.label ? { label: options.label } : {}) };
  const ctx: any = {
    mode: options.mode ?? "tui", hasUI: options.mode !== "print", isIdle: () => true,
    ui: { notify: (message: string) => notices.push(message), confirm: async () => typeof options.confirm === "function" ? options.confirm() : options.confirm !== false },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1", getEntries: () => entries,
      getBranch: () => [...(options.history ?? []), ...entries],
      buildContextEntries: () => options.history ?? [],
    },
    modelRegistry: { find: (provider: string, model: string) => options.missingModel ||
      (options.models && !options.models.includes(`${provider}/${model}`)) ? undefined : { id: model, provider } },
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
      return options.exec ? options.exec(args, act) : act();
    },
  };
  register(pi, {
    preferencesFile,
    env: { ...env, ...options.env },
    classify: async (_config, data, signal) => { checks.push({ data, signal, config: _config }); return options.check ? options.check(data, signal) : "new_task"; },
    generateTitle: async (_config, data, allowed, _ctx, signal) => { titles.push({ data, allowed, signal, config: _config }); return options.title ? options.title(data, allowed, signal) : title; },
  });
  // Pi creates fresh context objects for each event and command, even within one session.
  const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, { ...ctx });
  const submit = (request: string, extra: any = {}) => emit("input", { text: request, source: "interactive", ...extra });
  const deliver = (request: string) => emit("message_start", { message: { role: "user", content: [{ type: "text", text: request }] } });
  const send = async (request: string) => { await submit(request); await emit("agent_start"); await deliver(request); };
  const assistant = (content: any, extra: any = {}) => emit("message_end", { message: {
    role: "assistant", stopReason: "stop", content: typeof content === "string" ? [{ type: "text", text: content }] : content, ...extra,
  } });
  const command = (arg: string) => commands.get("pane-naming")!(arg, { ...ctx });
  const renames = () => calls.filter((call) => call.args[1] === "rename");
  return { emit, submit, deliver, send, assistant, command, renames, pane, flags, entries, calls, checks, titles, notices, ctx, preferencesFile };
}

function response(choice = "new_task", confidence = 0.99) {
  return { success: true, errors: [], result: { state: "Completed", result: { answers: { naming: {
    type: "choice", choice, confidence,
    probabilities: { keep: choice === "keep" ? 1 : 0, update: choice === "update" ? 1 : 0, new_task: choice === "new_task" ? 1 : 0, uncertain: choice === "uncertain" ? 1 : 0 },
  } } } } };
}

test("only the main interactive inherited Herdr pane is eligible", async () => {
  assert.equal(eligible(env, { mode: "tui" }), true);
  for (const options of [{ mode: "rpc" }, { mode: "print" }, { mode: "json" }, { env: { HERDR_ENV: "0" } }, { env: { HERDR_PANE_ID: "" } }, { env: { PI_SUBAGENT_CHILD: "1" } }, { on: false }]) {
    const h = harness(options);
    await h.emit("session_start"); await h.send("Fix login"); await settle();
    assert.equal(h.calls.length, 0); assert.equal(h.checks.length, 0);
  }
});

test("delivery triggers background naming, not queue submission or ordinary tools", async () => {
  const h = harness(); await h.emit("session_start");
  await h.submit("Fix login", { streamingBehavior: "followUp" }); await settle();
  assert.equal(h.checks.length, 0);
  await h.deliver("Fix login"); await until(() => h.renames().length === 1);
  assert.equal(h.pane.label, "Fix login");
  await h.emit("tool_result", { toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "anything" }] });
  await h.emit("agent_end"); await h.emit("agent_settled"); await settle();
  assert.equal(h.checks.length, 1); assert.equal(h.titles.length, 1);
  assert.equal(h.renames()[0].args[2], env.HERDR_PANE_ID);
  assert.equal(JSON.stringify(h.entries).includes(credentials.apiToken), false);
});

test("assistant activity renames without another prompt, coalesces bursts and skips repeated snapshots", async (t) => {
  const tick = activityClock(t);
  const h = harness({ title: (data: any) => ({ title: data.activity ? "Debugging login" : "Login research", prs: [] }) });
  await h.emit("session_start"); await h.send("Investigate login failures"); await settle();
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
  assert.equal(JSON.stringify(h.entries).includes("I found the cause"), false);
});

test("tool-only messages retain the latest progress text; a new request clears it", async (t) => {
  const tick = activityClock(t); const h = harness({ check: () => "keep" });
  await h.emit("session_start"); await h.send("Research login"); await settle();
  await h.assistant("Now debugging login.");
  await h.assistant([{ type: "toolCall", name: "bash", arguments: { command: "PRIVATE_ARGUMENT" } }], { stopReason: "toolUse" });
  await h.emit("agent_settled"); // A final pending snapshot still runs, but cannot authorize a future autonomous run.
  await tick();
  assert.deepEqual(h.checks[1].data.activity, { text: "Now debugging login.", tools: ["bash"] });
  await h.send("Research gardening"); await settle();
  await h.assistant([{ type: "toolCall", name: "web_search", arguments: {} }], { stopReason: "toolUse" });
  await tick(); assert.deepEqual(h.checks.at(-1).data.activity, { text: "", tools: ["web_search"] });
});

test("assistant checks cancel on the agent signal and failed snapshots are not retried", async (t) => {
  const tick = activityClock(t);
  for (const phase of ["queued", "check", "title", "write"]) {
    const pending = deferred(); const agent = new AbortController(); let reads = 0;
    const h = harness({
      check: (data: any) => !data.activity ? "keep" : phase === "check" ? pending.promise : "update",
      title: () => phase === "title" ? pending.promise : title,
      exec: async (args: string[], act: Function) => {
        if (phase === "write" && args[1] === "get" && ++reads === 4) await pending.promise;
        return act();
      },
    });
    await h.emit("session_start"); h.ctx.signal = agent.signal;
    await h.send("Fix login"); await settle(); await h.assistant("Debugging login");
    if (phase !== "queued") await tick();
    agent.abort(); pending.resolve(phase === "check" ? "update" : title); await tick();
    assert.equal(h.renames().length, 0, phase);
    assert.equal(h.entries.some((e) => e.customType === "herdr-pane-naming-failure"), false, phase);
    if (phase !== "queued") assert.equal(h.checks[1].signal.aborted, true);
  }
  const h = harness({ check: (data: any) => {
    if (data.activity) throw new Error("PRIVATE_FAILURE"); return "keep";
  } });
  await h.emit("session_start"); await h.send("Fix login"); await settle();
  await h.assistant("Debugging login"); await tick();
  await h.assistant("Debugging login"); await tick(300_000);
  assert.equal(h.checks.length, 2);
  assert.equal(h.entries.filter((e) => e.customType === "herdr-pane-naming-failure").length, 1);
  assert.equal(JSON.stringify([h.entries, h.notices]).includes("PRIVATE_FAILURE"), false);
});

test("tool-only assistant activity sends bounded names, not arguments, results or thinking", async (t) => {
  const tick = activityClock(t); const h = harness({ check: () => "keep" });
  await h.emit("session_start"); await h.send("Research login"); await settle();
  const tools = ["web_search", "fetch_content", "web_search"].map((name, i) => ({
    type: "toolCall", id: `call-${i}`, name, arguments: { query: "PRIVATE_ARGUMENT", path: "PRIVATE_PATH" },
  }));
  await h.assistant([{ type: "thinking", thinking: "PRIVATE_THINKING" }, ...tools], { stopReason: "toolUse" });
  await h.emit("tool_result", { toolCallId: "call-0", toolName: "web_search", content: [{ type: "text", text: "PRIVATE_RESULT" }] });
  await tick();
  assert.equal(h.checks.length, 2);
  assert.deepEqual(h.checks[1].data.activity, { text: "", tools: ["fetch_content", "web_search"] });
  await h.assistant([...tools].reverse(), { stopReason: "toolUse" }); await tick();
  assert.equal(h.checks.length, 2, "order, call IDs and arguments do not imply an activity change");
  await h.assistant([
    { type: "text", text: "x".repeat(2_000) }, ...Array.from({ length: 20 }, (_, i) => ({ type: "toolCall", name: `tool_${i}`, arguments: {} })),
    { type: "toolCall", name: "PRIVATE_INVALID name", arguments: {} },
  ], { stopReason: "toolUse" }); await tick();
  assert.equal(h.checks[2].data.activity.text.length, 600);
  assert.equal(h.checks[2].data.activity.tools.length, 8);
  assert.equal(h.checks[2].data.replyContext, "");
  assert.equal(JSON.stringify([h.checks, h.entries, h.notices]).includes("PRIVATE_"), false);
});

test("assistant activity cannot bypass input provenance, mode, ownership or completion gates", async (t) => {
  const tick = activityClock(t);
  for (const options of [{ mode: "rpc" }, { mode: "print" }, { mode: "json" }, { env: { PI_SUBAGENT_CHILD: "1" } }, { on: false }, { label: "My name" }]) {
    const h = harness(options); await h.emit("session_start"); await h.send("Fix login");
    await h.assistant("Now debugging login"); await tick(); assert.equal(h.checks.length, 0);
  }
  const h = harness(); await h.emit("session_start");
  await h.assistant("Old history must not bootstrap activity"); await tick();
  for (const [request, extra, delivered] of [
    ["automation", { source: "extension" }, "automation"], ["rpc", { source: "rpc" }, "rpc"],
    ["/skill:test", {}, "expanded skill"], ["image", { images: [{}] }, "image"], ["original", {}, "transformed"],
  ] as const) {
    await h.submit(request, extra); await h.deliver(delivered);
    await h.assistant("Now debugging login"); await tick(); assert.equal(h.checks.length, 0);
  }
  await h.send("Fix login"); await settle();
  for (const stopReason of ["pending", "length", "error", "deferred"]) {
    await h.assistant("Incomplete activity", { stopReason }); await tick();
  }
  await h.assistant([{ type: "thinking", thinking: "Not visible" }]);
  await h.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: "Streaming" }] } });
  await h.emit("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "Tool text" }] } });
  await tick(); assert.equal(h.checks.length, 1);
  await h.emit("agent_settled");
  await h.assistant("Unrelated extension-triggered response"); await tick(); assert.equal(h.checks.length, 1);
});

test("new user delivery, navigation, off, abort and injected messages discard pending assistant work", async (t) => {
  const tick = activityClock(t);
  for (const action of ["new-user", "excluded-user", "custom", "autonomous-run", "off", "abort", "session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "session_start"]) {
    const h = harness({ check: () => "keep" }); await h.emit("session_start"); await h.send("Research login"); await settle();
    await h.assistant("Now debugging login");
    if (action === "new-user") await h.send("Research gardening");
    else if (action === "excluded-user") { await h.submit("automation", { source: "extension" }); await h.deliver("automation"); }
    else if (action === "custom") await h.emit("message_start", { message: { role: "custom", content: "Injected work" } });
    else if (action === "autonomous-run") { await h.emit("agent_settled"); await h.emit("agent_start"); }
    else if (action === "off") await h.command("off");
    else if (action === "abort") await h.assistant("Aborted text", { stopReason: "aborted" });
    else await h.emit(action);
    await tick();
    assert.equal(h.checks.length, action === "new-user" ? 2 : 1, action);
    assert.equal(h.checks.some((check) => check.data.activity), false, action);
  }
  const h = harness({ check: () => "keep" }); await h.emit("session_start"); await h.send("Research login"); await settle();
  await h.assistant("Debugging login"); await h.submit("queued task", { streamingBehavior: "followUp" });
  await tick(); assert.equal(h.checks.length, 2, "queue submission must not cancel active work");
});

test("enabling and re-enabling naming retain an observed human task without another prompt", async (t) => {
  const tick = activityClock(t);
  const h = harness({ on: false, title: (data: any) => ({ title: data.activity.text, prs: [] }) });
  await h.emit("session_start"); await h.send("Fix login"); await settle();
  assert.equal(h.checks.length, 0);
  await h.command("on"); assert.equal(h.checks.length, 0, "enablement must not replay a request");
  await h.assistant("Debugging login"); await tick();
  assert.equal(h.pane.label, "Debugging login");
  await h.command("off"); await h.assistant("Work while naming is off"); await tick();
  assert.equal(h.checks.length, 1);
  await h.command("on"); await h.assistant("Testing login"); await tick();
  assert.equal(h.pane.label, "Testing login"); assert.equal(h.checks.length, 2);
  for (const [request, extra, delivered] of [
    ["Not human", { source: "extension" }, "Not human"], ["RPC", { source: "rpc" }, "RPC"],
    ["/skill:test", {}, "expanded skill"], ["original", {}, "transformed"], ["image", { images: [{}] }, "image"],
  ] as const) {
    await h.command("off"); await h.submit(request, extra); await h.deliver(delivered);
    await h.command("on"); await h.assistant("Do not name this"); await tick();
    assert.equal(h.checks.length, 2, request);
  }
});

test("reload restores only the same running human task and preserves its cooldown", async (t) => {
  const tick = activityClock(t);
  const history: any[] = [{ type: "message", id: "request-1", message: { role: "user", content: "PRIVATE_REQUEST" } }];
  const h = harness({ history, check: () => "keep" });
  h.ctx.isIdle = () => false;
  await h.emit("session_start"); await h.send("PRIVATE_REQUEST"); await settle();
  await h.assistant("Debugging login");
  history.push({ type: "message", id: "progress-1", message: { role: "assistant", stopReason: "toolUse", content: [
    { type: "text", text: "Debugging login" }, { type: "thinking", thinking: "PRIVATE_THINKING" },
  ] } });
  await tick(10_000);
  await h.emit("session_shutdown", { reason: "reload" });
  const stored = JSON.parse(JSON.stringify(h.entries));
  assert.equal(JSON.stringify(stored).includes("PRIVATE_REQUEST"), false);
  for (const options of [
    {}, { idle: true }, { aborted: true }, { reason: "startup" }, { sessionId: "other-session" },
    { env: { HERDR_PANE_ID: "other-pane" } }, { terminalId: "other-terminal" }, { label: "Manual name" },
    { env: { PI_SUBAGENT_CHILD: "1" } }, { mode: "rpc" }, { history: [] },
    { entries: stored.filter((e: any) => e.customType !== "herdr-pane-naming-reload-scope") },
    { history: [...history, { type: "message", id: "request-2", message: { role: "user", content: "PRIVATE_REQUEST" } }] },
    { history: [...history, { type: "custom_message", id: "injected", content: "Do not inherit human scope" }] },
  ] as any[]) {
    const resumed = harness({ history, entries: structuredClone(stored), ...options });
    resumed.ctx.isIdle = () => options.idle === true;
    if (options.aborted) resumed.ctx.signal = AbortSignal.abort();
    if (options.terminalId) resumed.pane.terminal_id = options.terminalId;
    await resumed.emit("session_start", { reason: options.reason ?? "reload" });
    assert.equal(resumed.checks.length, 0, "reload must not replay a naming request");
    await resumed.assistant([{ type: "toolCall", name: "bash", arguments: { command: "PRIVATE_ARGUMENT" } }], { stopReason: "toolUse" });
    await tick(19_999);
    const restores = Object.keys(options).length === 0;
    assert.equal(resumed.checks.length, 0, "reload must preserve the last check's cooldown");
    await tick(1); assert.equal(resumed.checks.length, restores ? 1 : 0);
    if (restores) {
      assert.equal(resumed.checks[0].data.request, "PRIVATE_REQUEST");
      assert.deepEqual(resumed.checks[0].data.activity, { text: "Debugging login", tools: ["bash"] });
      assert.equal(resumed.pane.label, "Fix login");
      assert.equal(JSON.stringify(resumed.entries).includes("PRIVATE_"), false);
    }
    await resumed.emit("session_shutdown");
  }
});

test("reload cannot revive ended scope and can retain an eligible task while naming is off", async (t) => {
  const tick = activityClock(t);
  for (const action of ["off", "agent_settled", "abort", "custom", "session_before_tree"]) {
    const history = [{ type: "message", id: "request-1", message: { role: "user", content: "Fix login" } }];
    const h = harness({ history, check: () => "keep" }); h.ctx.isIdle = () => false;
    await h.emit("session_start"); await h.send("Fix login"); await settle();
    if (action === "off") await h.command("off");
    else if (action === "abort") await h.assistant("Aborted", { stopReason: "aborted" });
    else if (action === "custom") await h.emit("message_start", { message: { role: "custom", content: "Injected work" } });
    else await h.emit(action);
    await h.emit("session_shutdown", { reason: "reload" });
    const resumed = harness({ history, entries: structuredClone(h.entries), on: false }); resumed.ctx.isIdle = () => false;
    await resumed.emit("session_start", { reason: "reload" });
    await resumed.command("on"); await resumed.assistant("Debugging login"); await tick();
    assert.equal(resumed.checks.length, action === "off" ? 1 : 0, action);
    await resumed.emit("session_shutdown");
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
    await h.emit("session_start"); await h.send("Fix login"); await settle();
    await h.assistant("Old phase"); await tick();
    await until(() => phase === "check" ? h.checks.length === 2 : h.titles.length === 1);
    await h.assistant("New phase"); pending.resolve(phase === "check" ? "update" : { title: "Old phase", prs: [] });
    await settle(); assert.equal(h.renames().length, 0);
    await tick(); assert.equal(h.pane.label, "New phase");
    assert.equal(h.checks[1].signal.aborted, true);
    assert.equal(h.entries.some((e) => e.customType === "herdr-pane-naming-failure"), false);
  }
});

test("assistant checks share the session budget and never overwrite a manual name", async (t) => {
  const tick = activityClock(t);
  const h = harness({ check: () => "keep" }); await h.emit("session_start"); await h.send("Fix login"); await settle();
  for (let i = 1; i <= DEFAULT_CHECK_LIMIT; i++) { await h.assistant(`Phase ${i}`); await tick(); }
  assert.equal(h.checks.length, DEFAULT_CHECK_LIMIT);
  assert.equal(h.entries.at(-1).data.checks, DEFAULT_CHECK_LIMIT);
  assert.ok(h.notices.some((notice) => notice.includes("session limit")));
  for (const during of [false, true]) {
    const pending = deferred(); const manual = harness({ check: (data: any) => data.activity ? pending.promise : "keep" });
    await manual.emit("session_start"); await manual.send("Fix login"); await settle();
    await manual.assistant("Now debugging login");
    if (during) await tick();
    manual.pane.label = "My manual name"; pending.resolve("update"); await tick();
    assert.equal(manual.pane.label, "My manual name"); assert.equal(manual.renames().length, 0);
    assert.equal(manual.checks.length, during ? 2 : 1);
  }
});

test("assistant text cannot authorize invented PRs; confirmed creation survives an activity delay", async (t) => {
  const tick = activityClock(t);
  const h = harness({ title: (_data: any, allowed: string[]) => ({ title: "Login", prs: allowed }) });
  await h.emit("session_start"); await h.send("Fix login"); await settle();
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

test("automated, transformed, slash and image inputs do not start naming", async () => {
  const h = harness(); await h.emit("session_start");
  for (const source of ["extension", "rpc"]) { await h.submit("private automation", { source }); await h.deliver("private automation"); }
  await h.submit("/skill:test"); await h.deliver("expanded skill");
  await h.submit("look", { images: [{ type: "image" }] }); await h.deliver("look");
  await h.submit("before transform"); await h.deliver("after transform");
  await h.deliver("input never observed"); await settle();
  assert.equal(h.checks.length, 0);
});

test("keep/uncertain avoid title calls; identical output avoids redundant renames", async () => {
  let decision = "new_task";
  const h = harness({ check: () => decision }); await h.emit("session_start");
  await h.send("Fix login"); await until(() => h.renames().length === 1); await settle();
  for (decision of ["keep", "uncertain", "update"]) { await h.send("continue"); await settle(); }
  assert.equal(h.checks.length, 4); assert.equal(h.titles.length, 2); assert.equal(h.renames().length, 1);
});

test("existing labels are preserved until an explicit user adoption", async () => {
  const h = harness({ label: "My chosen name" }); await h.emit("session_start"); await h.send("Fix login"); await settle();
  assert.equal(h.checks.length, 0); assert.equal(h.pane.label, "My chosen name");
  await h.command("adopt"); await h.send("Fix login"); await until(() => h.renames().length === 1);
  assert.equal(h.pane.label, "Fix login");
  const declined = harness({ label: "Keep me", confirm: false });
  await declined.emit("session_start"); await declined.command("adopt"); await declined.send("Fix it"); await settle();
  assert.equal(declined.checks.length, 0);
});

test("on enables a disabled session and reports configuration failures", async () => {
  const h = harness({ on: false }); await h.emit("session_start");
  await h.command("on"); await h.send("Fix login"); await until(() => h.renames().length === 1);
  assert.ok(h.notices.some((notice) => notice.startsWith("Pane naming on:")));
  const failed = harness({ on: false, missingModel: true }); await failed.emit("session_start");
  await failed.command("on");
  assert.ok(failed.notices.some((notice) => notice.startsWith("Pane naming is off: check")));
  assert.equal(failed.checks.length, 0);
});

test("enabling once saves the model and automatically names a new pane without flags or adoption", async () => {
  const first = harness({ on: false }); await first.emit("session_start"); await first.command("on");
  assert.deepEqual(JSON.parse(await readFile(first.preferencesFile, "utf8")), { enabled: true, titleModel: "google/test-model" });
  const second = harness({
    on: false, flags: { "pane-naming-model": undefined }, preferencesFile: first.preferencesFile,
    sessionId: "second-session", env: { HERDR_PANE_ID: "second-pane" },
    confirm: () => { throw new Error("New unnamed panes must not need adoption"); },
  });
  await second.emit("session_start");
  assert.equal(second.checks.length, 0, "startup must not call a model");
  await second.send("Fix login"); await until(() => second.renames().length === 1);
  assert.equal(second.renames()[0].args[2], "second-pane");
  assert.equal(first.renames().length, 0);
  assert.ok(second.notices.some((notice) => notice.includes("google/test-model")));
  await second.command("off");
  const third = harness({ on: false, flags: { "pane-naming-model": undefined }, preferencesFile: first.preferencesFile });
  await third.emit("session_start"); await third.send("Fix login"); await settle();
  assert.equal(third.calls.length, 0); assert.equal(third.checks.length, 0);
  assert.deepEqual(JSON.parse(await readFile(first.preferencesFile, "utf8")), { enabled: false, titleModel: "google/test-model" });
});

test("command settings persist, apply locally without reload, and become new-pane defaults", async (t) => {
  const tick = activityClock(t);
  const h = harness({ models: ["google/test-model", "google/new-model"] });
  await h.emit("session_start"); await h.command("on");
  for (const command of ["cooldown 5", "limit 3", "model google/new-model"]) await h.command(command);
  assert.deepEqual(JSON.parse(await readFile(h.preferencesFile, "utf8")), {
    enabled: true, titleModel: "google/new-model", cooldownSeconds: 5, checkLimit: 3,
  });
  assert.equal(h.checks.length, 0, "setting values must not invent a request");
  await h.send("Fix login"); await settle();
  assert.equal(h.titles[0].config.model, "new-model", "a command supersedes the startup model flag");
  await h.assistant("Now debugging login"); await tick(4_999); assert.equal(h.checks.length, 1);
  await tick(1); assert.equal(h.checks.length, 2);
  await h.command("off"); await h.command("on");
  await h.send("continue"); await settle(); assert.equal(h.titles.at(-1).config.model, "new-model");
  await h.send("one too many"); await settle(); assert.equal(h.checks.length, 3);
  const next = harness({ on: false, flags: { "pane-naming-model": undefined }, preferencesFile: h.preferencesFile,
    sessionId: "next-session", env: { HERDR_PANE_ID: "next-pane" } });
  await next.emit("session_start"); await next.command("status");
  assert.ok(next.notices.at(-1)?.includes("0/3")); assert.ok(next.notices.at(-1)?.includes("Cooldown: 5s"));
  await next.send("New work"); await settle(); assert.equal(next.titles[0].config.model, "new-model");
});

test("cooldown commands reschedule queued activity from the last actual attempt", async (t) => {
  const tick = activityClock(t); const h = harness({ check: () => "keep" });
  await h.emit("session_start"); await h.send("Fix login"); await settle();
  await h.assistant("Debugging login"); await tick(10_000); await h.command("cooldown 60");
  await tick(20_000); assert.equal(h.checks.length, 1, "the old 30s timer must not run");
  await tick(29_999); assert.equal(h.checks.length, 1); await tick(1); assert.equal(h.checks.length, 2);
  await h.assistant("Testing login"); await tick(10_000); await h.command("cooldown 5"); await settle();
  assert.equal(h.checks.length, 3, "an already-queued, now-due check may run immediately");
  await tick(60_000); assert.equal(h.checks.length, 3, "no duplicate timer or polling");
});

test("limit commands never reset attempts or enable a paused or independently named pane", async () => {
  const h = harness({ check: () => "keep" }); await h.emit("session_start"); await h.command("on");
  for (let i = 0; i < 3; i++) { await h.send("continue"); await settle(); }
  await h.command("limit 2"); await h.send("blocked"); await settle();
  await h.command("status"); assert.ok(h.notices.at(-1)?.includes("3/2"));
  assert.ok(h.notices.at(-1)?.startsWith("Pane naming off"));
  await h.command("limit 5"); await h.send("still off"); await settle(); assert.equal(h.checks.length, 3);
  await h.command("on"); await h.send("continue"); await settle();
  assert.equal(h.entries.at(-1).data.checks, 4);
  await h.emit("session_shutdown"); await h.emit("session_start"); await h.command("status");
  assert.ok(h.notices.at(-1)?.includes("4/5"));
  const protectedPane = harness({ label: "My name" }); await protectedPane.emit("session_start");
  for (const command of ["limit 100", "cooldown 10", "model google/new-model"]) await protectedPane.command(command);
  await protectedPane.send("Fix login"); await settle();
  assert.equal(protectedPane.checks.length, 0); assert.equal(protectedPane.pane.label, "My name");
  assert.equal(JSON.parse(await readFile(protectedPane.preferencesFile, "utf8")).enabled, false);
  for (const phase of ["check", "title"]) {
    const pending = deferred();
    const busy = harness({ check: () => phase === "check" ? pending.promise : "update", title: () => pending.promise });
    await busy.emit("session_start"); await busy.send("Fix login");
    await until(() => phase === "check" ? busy.checks.length === 1 : busy.titles.length === 1);
    await busy.command("limit 1"); pending.resolve(phase === "check" ? "update" : title); await settle();
    assert.equal(busy.checks[0].signal.aborted, true); assert.equal(busy.renames().length, 0);
    assert.equal(busy.entries.at(-1).data.checks, 1);
  }
});

test("model changes cancel old work but preserve eligibility for future assistant activity", async (t) => {
  const tick = activityClock(t);
  for (const phase of ["queued", "check", "title", "write"]) {
    const pending = deferred(); let reads = 0;
    const h = harness({
      check: (data: any) => !data.activity ? "keep" : phase === "check" && data.activity.text === "Old phase" ? pending.promise : "update",
      title: (data: any) => phase === "title" && data.activity.text === "Old phase" ? pending.promise : { title: data.activity.text, prs: [] },
      exec: async (args: string[], act: Function) => {
        if (phase === "write" && args[1] === "get" && ++reads === 4) await pending.promise;
        return act();
      },
    });
    await h.emit("session_start"); await h.send("Fix login"); await settle(); await h.assistant("Old phase");
    if (phase !== "queued") await tick();
    const attempts = h.checks.length;
    await h.command("model google/new-model"); pending.resolve(phase === "check" ? "update" : title);
    await tick(); assert.equal(h.renames().length, 0, phase); assert.equal(h.checks.length, attempts);
    await h.assistant("New phase"); await tick();
    assert.equal(h.pane.label, "New phase"); assert.equal(h.titles.at(-1).config.model, "new-model");
    assert.equal(h.entries.some((e) => e.customType === "herdr-pane-naming-failure"), false);
  }
});

test("a model command invalidates pending enablement even when it matches a startup flag", async () => {
  const pending = deferred(); let waiting = false;
  const h = harness({ on: false, exec: async (_args: string[], act: Function) => {
    waiting = true; await pending.promise; return act();
  } });
  await h.emit("session_start");
  const enabling = h.command("on"); await until(() => waiting);
  await h.command("model google/test-model"); pending.resolve(undefined); await enabling;
  await h.command("status"); assert.ok(h.notices.at(-1)?.startsWith("Pane naming off"));
  assert.equal(JSON.parse(await readFile(h.preferencesFile, "utf8")).enabled, false);
  assert.equal(h.entries.length, 0, "cancelled enablement must not persist ownership");
});

test("settings from another pane do not alter local runtime via status or an unrelated setting", async (t) => {
  const tick = activityClock(t); const a = harness(); await a.emit("session_start"); await a.command("on");
  const b = harness({ on: false, flags: { "pane-naming-model": undefined }, preferencesFile: a.preferencesFile });
  await b.emit("session_start");
  await a.command("cooldown 5"); await a.command("limit 100"); await a.command("model google/new-model");
  await b.command("status");
  assert.ok(b.notices.at(-1)?.includes("0/40")); assert.ok(b.notices.at(-1)?.includes("Cooldown: 30s"));
  assert.ok(b.notices.at(-1)?.includes("Title model: google/test-model"));
  await b.command("limit 10"); await b.send("Fix login"); await settle();
  assert.equal(b.titles[0].config.model, "test-model");
  await b.assistant("Testing login"); await tick(5_000); assert.equal(b.checks.length, 1);
  await tick(25_000); assert.equal(b.checks.length, 2);
  assert.deepEqual(JSON.parse(await readFile(a.preferencesFile, "utf8")), {
    enabled: true, titleModel: "google/new-model", cooldownSeconds: 5, checkLimit: 10,
  });
});

test("invalid settings and unsupported contexts cannot mutate preferences or live work", async () => {
  const h = harness({ models: ["google/test-model"] }); await h.emit("session_start"); await h.command("on");
  const original = await readFile(h.preferencesFile, "utf8");
  for (const command of ["cooldown", "cooldown 0", "cooldown 3601", "cooldown 1.5", "cooldown 2s", "cooldown 1e2",
    "limit -1", "limit 1001", "limit Infinity", "limit 1 extra", "model", "model no-provider", "model google/missing", "model google/test-model extra", "off extra"]) {
    await h.command(command); assert.equal(await readFile(h.preferencesFile, "utf8"), original, command);
  }
  await h.send("Fix login"); await settle(); assert.equal(h.checks.length, 1);
  for (const options of [{ mode: "rpc" }, { mode: "print" }, { mode: "json" }, { env: { PI_SUBAGENT_CHILD: "1" } }]) {
    const blocked = harness({ ...options, preferencesFile: h.preferencesFile }); await blocked.emit("session_start");
    for (const command of ["cooldown 10", "limit 100", "model google/test-model"]) await blocked.command(command);
    assert.equal(await readFile(h.preferencesFile, "utf8"), original);
  }
  for (const bad of [{ cooldownSeconds: 0 }, { cooldownSeconds: 1.5 }, { cooldownSeconds: "PRIVATE_MARKER" },
    { cooldownSeconds: 3601 }, { checkLimit: 0 }, { checkLimit: 1001 }, { checkLimit: null }]) {
    const raw = JSON.stringify({ enabled: true, titleModel: "google/test-model", ...bad });
    await writeFile(h.preferencesFile, raw); await h.emit("session_start"); await h.send("Must not run"); await settle();
    await h.command("cooldown 30"); assert.equal(await readFile(h.preferencesFile, "utf8"), raw);
  }
  assert.equal(h.checks.length, 1); assert.equal(h.notices.join("\n").includes("PRIVATE_MARKER"), false);
});

test("failed atomic settings writes leave both runtime settings and the saved file unchanged", async (t) => {
  const h = harness(); await h.emit("session_start"); await h.command("on");
  const original = await readFile(h.preferencesFile, "utf8");
  const beforeFiles = await readdir(preferencesDirectory);
  t.mock.method(fs, "renameSync", () => { throw new Error("PRIVATE_WRITE_FAILURE"); });
  syncBuiltinESMExports();
  try {
    for (const command of ["cooldown 5", "limit 2", "model google/new-model"]) await h.command(command);
    await h.command("status");
    assert.ok(h.notices.at(-1)?.includes("0/40")); assert.ok(h.notices.at(-1)?.includes("Cooldown: 30s"));
    assert.ok(h.notices.at(-1)?.includes("Title model: google/test-model"));
    assert.equal(await readFile(h.preferencesFile, "utf8"), original);
    assert.deepEqual(await readdir(preferencesDirectory), beforeFiles, "temporary preference files must be removed");
    assert.equal(h.notices.join("\n").includes("PRIVATE_WRITE_FAILURE"), false);
    assert.ok(h.notices.some((n) => /could not|couldn't/i.test(n)));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  await h.send("Fix login"); await settle(); assert.equal(h.titles[0].config.model, "test-model");
});

test("global enable still preserves existing names and excludes noninteractive or child sessions", async () => {
  const owner = harness({ on: false, label: "Existing name" }); await owner.emit("session_start"); await owner.command("adopt");
  assert.equal(JSON.parse(await readFile(owner.preferencesFile, "utf8")).enabled, true);
  for (const options of [{ label: "User chosen name" }, { mode: "rpc" }, { mode: "print" }, { mode: "json" }, { env: { PI_SUBAGENT_CHILD: "1" } }, { env: { HERDR_ENV: "0" } }]) {
    const h = harness({ ...options, on: false, flags: { "pane-naming-model": undefined }, preferencesFile: owner.preferencesFile });
    await h.emit("session_start"); await h.send("Fix login"); await settle();
    assert.equal(h.checks.length, 0); assert.equal(h.renames().length, 0);
  }
});

test("startup flag overrides are session-only; declined adoption does not save a global default", async () => {
  const h = harness(); await h.emit("session_start");
  await assert.rejects(readFile(h.preferencesFile), { code: "ENOENT" });
  const declined = harness({ on: false, label: "Keep me", confirm: false });
  await declined.emit("session_start"); await declined.command("adopt");
  await assert.rejects(readFile(declined.preferencesFile), { code: "ENOENT" });
  await writeFile(h.preferencesFile, JSON.stringify({ enabled: true, titleModel: "google/saved-model" }));
  h.flags["pane-naming-model"] = "google/override-model";
  await h.emit("session_start"); await h.command("status");
  assert.ok(h.notices.at(-1)?.includes("google/override-model"));
  assert.equal(JSON.parse(await readFile(h.preferencesFile, "utf8")).titleModel, "google/saved-model");
  h.flags["pane-naming-model"] = undefined; await h.emit("session_start");
  await writeFile(h.preferencesFile, JSON.stringify({ enabled: true, titleModel: "google/changed-elsewhere" }));
  await h.command("status");
  assert.ok(h.notices.at(-1)?.includes("Title model: google/saved-model"), "status must show the model this pane is actually using");
});

test("invalid global preferences fail closed without being overwritten; off still stops this pane", async () => {
  const h = harness(); await h.emit("session_start");
  const invalid = '{"enabled":true,"private-marker":';
  await writeFile(h.preferencesFile, invalid);
  await h.command("off"); await h.send("Fix login"); await settle();
  assert.equal(h.checks.length, 0);
  assert.ok(h.notices.at(-1)?.includes("global default could not be saved"));
  await h.emit("session_start"); await h.command("on"); await h.send("Fix login"); await settle();
  assert.equal(h.checks.length, 0);
  assert.equal(await readFile(h.preferencesFile, "utf8"), invalid);
  assert.equal(h.notices.join("\n").includes("private-marker"), false);
  for (const value of [{ enabled: "true", titleModel: "google/test" }, { enabled: true, titleModel: "no-provider" }]) {
    await writeFile(h.preferencesFile, JSON.stringify(value)); await h.emit("session_start");
    await h.send("Fix login"); await settle(); assert.equal(h.checks.length, 0);
  }
});

test("cancellation during an adoption read or confirmation cannot re-enable naming", async () => {
  for (const phase of ["read", "confirm"]) for (const action of ["off", "session_shutdown", "session_start"]) {
    const pending = deferred(); let waiting = false;
    const h = harness({
      on: false, label: "Keep me",
      exec: async (_args: string[], act: Function) => {
        if (phase === "read") { waiting = true; await pending.promise; }
        return act();
      },
      confirm: async () => { waiting = true; return pending.promise; },
    });
    await h.emit("session_start");
    const adopting = h.command("adopt"); await until(() => waiting);
    if (action === "off") await h.command("off"); else await h.emit(action);
    pending.resolve(true); await adopting;
    assert.equal(h.entries.length, 0);
    assert.equal(h.notices.some((notice) => notice.startsWith("Pane naming on:")), false);
    assert.equal(h.pane.label, "Keep me");
    const global = await readFile(h.preferencesFile, "utf8").then(JSON.parse, (error) => {
      assert.equal(error.code, "ENOENT"); return { enabled: false };
    });
    assert.equal(global.enabled, false);
  }
});

test("outside renames before and during model work stop automation", async () => {
  for (const during of [false, true]) {
    const pending = deferred();
    const h = harness({ title: () => pending.promise }); await h.emit("session_start");
    if (!during) h.pane.label = "User name";
    await h.send("Fix login");
    if (during) { await until(() => h.titles.length === 1); h.pane.label = "User name"; }
    pending.resolve(title); await settle();
    assert.equal(h.pane.label, "User name"); assert.equal(h.renames().length, 0);
    if (!during) assert.equal(h.checks.length, 0);
    await h.send("another request"); await settle(); assert.equal(h.renames().length, 0);
  }
});

test("late classification and title results cannot rename a newer task", async () => {
  for (const phase of ["check", "title"]) {
    const old = deferred();
    const h = harness({
      check: (data: any) => phase === "check" && data.request === "old" ? old.promise : "new_task",
      title: (data: any) => phase === "title" && data.request === "old" ? old.promise : { title: data.request, prs: [] },
    });
    await h.emit("session_start"); await h.send("old");
    await until(() => phase === "check" ? h.checks.length === 1 : h.titles.length === 1);
    await h.send("new"); await until(() => h.pane.label === "new");
    old.resolve(phase === "check" ? "new_task" : { title: "old", prs: [] }); await settle();
    assert.equal(h.pane.label, "new"); assert.equal(h.renames().length, 1);
    assert.equal(h.checks[0].signal.aborted, true);
  }
});

test("shutdown, off, and tree navigation invalidate pending model work", async () => {
  for (const action of ["session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "off"]) {
    const pending = deferred(); const h = harness({ title: () => pending.promise });
    await h.emit("session_start"); await h.send("old"); await until(() => h.titles.length === 1);
    if (action === "off") await h.command("off"); else await h.emit(action);
    pending.resolve(title); await settle(); assert.equal(h.renames().length, 0);
  }
});

test("a stale Herdr read cannot initiate a rename", async () => {
  const read = deferred(); let gets = 0;
  const h = harness({ exec: async (args: string[], act: Function) => {
    if (args[1] === "get" && ++gets === 3) await read.promise;
    return act();
  } });
  await h.emit("session_start"); await h.send("old"); await until(() => gets === 3);
  await h.command("off"); read.resolve(undefined); await settle(); assert.equal(h.renames().length, 0);
});

test("shutdown waits only for an already-issued bounded CLI write", async () => {
  const pending = deferred(); const h = harness({ exec: async (args: string[], act: Function) => {
    if (args[1] === "rename") await pending.promise;
    return act();
  } });
  await h.emit("session_start"); await h.send("Fix login"); await until(() => h.renames().length === 1);
  let stopped = false; const shutdown = h.emit("session_shutdown").then(() => { stopped = true; });
  await settle(); assert.equal(stopped, false);
  pending.resolve(undefined); await shutdown; assert.equal(stopped, true);
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
  await h.emit("session_start"); await h.send("old"); await until(() => renames === 1);
  await h.send("new"); await settle(); assert.equal(h.checks.length, 1);
  pending.resolve(undefined); await until(() => h.pane.label === "new");
  assert.equal(h.checks[1].data.currentName, "old"); assert.equal(h.renames().length, 2);
});

test("CLI and model failures are non-blocking, sanitized, and never automatically retried", async () => {
  for (const options of [
    { exec: async () => { throw new Error("secret diagnostic"); } },
    { check: async () => { throw new Error("secret diagnostic"); } },
    { title: async () => { throw new Error("secret diagnostic"); } },
    { exec: async (args: string[], act: Function) => args[1] === "rename" ? { code: 1, stderr: "secret diagnostic", stdout: "" } : act() },
  ]) {
    const h = harness(options); await h.emit("session_start"); await h.send("Fix login"); await settle();
    assert.ok(h.checks.length <= 1); assert.ok(h.titles.length <= 1); assert.ok(h.renames().length <= 1);
    assert.equal(h.notices.join("\n").includes("secret diagnostic"), false);
    assert.equal(h.pane.label, undefined);
  }
});

test("failures record their stage and sanitized reason without request content or raw errors", async () => {
  let reads = 0;
  for (const [stage, options, reason] of [
    ["Jev", { check: () => parseDecision(response("invalid")) }, "Jev returned an invalid naming choice."],
    ["Title model", { title: () => parseTitle("PRIVATE_MARKER invalid JSON", []) }, "Title model returned invalid JSON."],
    ["Title model", { title: () => parseTitle('{"title":"PRIVATE_MARKER","prs":["999"]}', []) }, "Title selected a PR outside the allowed list."],
    ["Title model", { title: () => parseTitle(JSON.stringify({ title: "PRIVATE_MARKER".repeat(5), prs: [] }), []) }, "Title exceeded 55 characters."],
    ["Herdr read", { exec: async (_args: string[], act: Function) => {
      if (++reads > 1) throw new Error("PRIVATE_MARKER"); return act();
    } }, "Unexpected error (details withheld)."],
  ] as const) {
    const h = harness(options); await h.emit("session_start"); await h.send("PRIVATE_MARKER"); await settle();
    const failures = h.entries.filter((e) => e.customType === "herdr-pane-naming-failure");
    assert.equal(failures.length, 1);
    const data = failures[0].data;
    assert.equal(data.stage, stage); assert.equal(data.reason, reason);
    assert.equal(data.sessionId, "session-1"); assert.equal(data.paneId, "own-pane");
    assert.equal(data.checks, stage === "Herdr read" ? 0 : 1);
    assert.equal(data.titles, stage === "Title model" ? 1 : 0);
    assert.ok(Number.isSafeInteger(data.elapsedMs) && data.elapsedMs >= 0);
    assert.ok(h.notices.at(-1)?.startsWith(`Pane naming failed at ${stage}`));
    assert.equal(JSON.stringify([h.notices, h.entries]).includes("PRIVATE_MARKER"), false);
    assert.equal(h.renames().length, 0);
  }
});

test("probability-sum failures persist numeric diagnostics without retrying or exposing raw data", async (t) => {
  const tick = activityClock(t);
  // Synthetic cases, not recovered responses from the live incident.
  for (const [probabilities, reason] of [
    [{ keep: 0.125, update: 0.125, new_task: 0.5, uncertain: 0.125 }, "Jev probabilities did not sum to 1. Sum: 0.875; absolute deviation: 0.125."],
    [{ keep: 0.125, update: 0.25, new_task: 0.5, uncertain: 0.25 }, "Jev probabilities did not sum to 1. Sum: 1.125; absolute deviation: 0.125."],
    [{ keep: 0, update: 0, new_task: 0.999, uncertain: 0 }, "Jev probabilities did not sum to 1. Sum: 0.999; absolute deviation: 0.0010000000000000009."],
  ] as const) {
    const value = response(); value.result.result.answers.naming.probabilities = probabilities;
    const h = harness({ label: "Preserve label", check: () => parseDecision({ ...value, message: "PRIVATE_MARKER" }) });
    await h.emit("session_start"); await h.command("adopt"); await h.send("PRIVATE_REQUEST"); await settle();
    await tick(300_000);
    const failures = h.entries.filter((e) => e.customType === "herdr-pane-naming-failure");
    assert.equal(failures.length, 1); assert.equal(failures[0].data.reason, reason);
    assert.ok(h.notices.at(-1)?.includes(reason));
    assert.equal(h.checks.length, 1); assert.equal(h.titles.length, 0); assert.equal(h.renames().length, 0);
    assert.equal(h.pane.label, "Preserve label");
    assert.equal(JSON.stringify([h.entries, h.notices]).includes("PRIVATE_"), false);
    await h.emit("session_shutdown"); await h.emit("session_start");
    assert.equal(h.entries.find((e) => e.customType === "herdr-pane-naming-failure").data.reason, reason);
  }
  for (const probability of ["PRIVATE_MARKER", NaN, Infinity, -1, 1.1, null]) {
    const value = response(); (value.result.result.answers.naming.probabilities as any).keep = probability;
    assert.throws(() => parseDecision(value), (error) => describeFailure(error) === "Jev returned invalid probabilities.");
  }
  for (const probabilities of [
    { keep: 0.25, update: 0.25, new_task: 0.5, uncertain: 0 },
    { keep: 0, update: 0, new_task: 0.9995, uncertain: 0 },
    { keep: 0, update: 0, new_task: 1, uncertain: 0.0005 },
  ]) {
    const value = response(); value.result.result.answers.naming.probabilities = probabilities;
    assert.equal(parseDecision(value), "new_task");
  }
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
    await h.emit("session_start"); await h.send("Fix login");
    await until(() => stage === "Jev" ? h.checks.length === 1 : h.titles.length === 1);
    deadlines.at(-1)!.abort(new DOMException("PRIVATE_MARKER", "TimeoutError"));
    await until(() => h.entries.some((e) => e.customType === "herdr-pane-naming-failure"));
    assert.equal(h.entries.at(-1).data.stage, stage);
    assert.equal(h.entries.at(-1).data.reason, "Naming request timed out.");
    await settle(); assert.equal(h.checks.length, 1); assert.equal(h.renames().length, 0);
    fail = false; await h.send("Continue fixing login"); await until(() => h.renames().length === 1);
    assert.equal(h.checks.length, 2);
    assert.equal(h.entries.filter((e) => e.customType === "herdr-pane-naming-failure").length, 1);
    assert.equal(JSON.stringify([h.entries, h.notices]).includes("PRIVATE_MARKER"), false);
  }
});

test("keep, uncertainty and cancelled work are not reported as failures", async () => {
  for (const decision of ["keep", "uncertain"]) {
    const h = harness({ check: () => decision }); await h.emit("session_start"); await h.send("continue"); await settle();
    assert.equal(h.entries.some((e) => e.customType === "herdr-pane-naming-failure"), false);
    assert.equal(h.notices.some((n) => n.startsWith("Pane naming failed")), false);
  }
  const pending = deferred();
  const h = harness({ check: async () => { await pending.promise; throw new Error("PRIVATE_MARKER"); } });
  await h.emit("session_start"); await h.send("old"); await until(() => h.checks.length === 1);
  await h.command("off"); pending.resolve(undefined); await settle();
  assert.equal(h.entries.some((e) => e.customType === "herdr-pane-naming-failure"), false);
  assert.equal(h.notices.some((n) => n.startsWith("Pane naming failed")), false);
});

test("wrong pane and terminal identities are rejected", async () => {
  const h = harness(); await h.emit("session_start"); h.pane.terminal_id = "replacement";
  await h.send("Fix login"); await settle(); assert.equal(h.checks.length, 0);
  const wrong = harness(); wrong.pane.pane_id = "someone-else";
  await wrong.emit("session_start"); await wrong.send("Fix login"); await settle(); assert.equal(wrong.checks.length, 0);
});

test("request context is bounded and excludes thinking, tools and full history", async () => {
  const h = harness({ history: [{ type: "message", message: { role: "assistant", content: [
    { type: "thinking", thinking: "private reasoning" }, { type: "text", text: "a".repeat(900) },
  ] } }] });
  await h.emit("session_start"); await h.send("x".repeat(10_000)); await until(() => h.checks.length === 1);
  assert.equal(h.checks[0].data.request.length, 2000); assert.equal(h.checks[0].data.replyContext.length, 600);
  assert.equal(JSON.stringify(h.checks[0].data).includes("private reasoning"), false);
});

test("call budget and ownership survive reload; copied state cannot claim a different session", async () => {
  const h = harness(); await h.emit("session_start"); await h.send("Fix login"); await until(() => h.renames().length === 1); await settle();
  await h.emit("session_shutdown");
  const resumed = harness({ entries: h.entries, label: "Fix login", check: () => "keep" });
  await resumed.emit("session_start"); await resumed.send("continue"); await settle();
  assert.equal(resumed.checks.length, 1); assert.equal(resumed.entries.at(-1).data.checks, 2);
  const fork = harness({ entries: h.entries, label: "Fix login", sessionId: "new-session" });
  await fork.emit("session_start"); await fork.send("new work"); await settle(); assert.equal(fork.checks.length, 0);
  for (let i = 2; i <= DEFAULT_CHECK_LIMIT; i++) { await resumed.send("continue"); await settle(); }
  assert.equal(resumed.checks.length, DEFAULT_CHECK_LIMIT - 1);
  assert.equal(resumed.entries.at(-1).data.checks, DEFAULT_CHECK_LIMIT);
});

test("new tasks cannot inherit old PR candidates; only explicit refs are offered", async () => {
  const h = harness({ title: (_data: any, allowed: string[]) => ({ title: "Review changes", prs: allowed }) });
  await h.emit("session_start"); await h.send("Review PR #123"); await until(() => h.renames().length === 1); await settle();
  assert.equal(h.pane.label, "PR #123 · Review changes");
  await h.send("Now fix the parser"); await until(() => h.renames().length === 2);
  assert.deepEqual(h.titles[1].allowed, []); assert.equal(h.pane.label, "Review changes");
});

test("merge PR 130 authorizes naming on user delivery and assistant activity", async (t) => {
  const tick = activityClock(t);
  // Synthetic model output: the live incident saved no rejected response bodies.
  for (const decision of ["new_task", "update"]) {
    const h = harness({
      label: "Creating pull request for evaluation changes", check: () => decision,
      title: (data: any, allowed: string[]) => parseTitle(JSON.stringify({
        title: data.activity ? "Merging PR 130" : "Preparing PR #130 merge", prs: ["130"],
      }), allowed),
    });
    await h.emit("session_start"); await h.command("adopt"); await h.send("merge PR 130 please."); await settle();
    assert.equal(h.pane.label, "PR #130 · Preparing merge");
    await h.assistant("I will check the head, then merge it."); await tick();
    assert.equal(h.pane.label, "PR #130 · Merging");
    assert.deepEqual(h.titles.map((call) => call.allowed), [["130"], ["130"]]);
    assert.equal(h.entries.some((e) => e.customType === "herdr-pane-naming-failure"), false);
    await h.emit("session_shutdown");
  }
});

test("confirmed gh pr creation updates a title without another model call", async () => {
  const h = harness(); await h.emit("session_start"); await h.send("Implement login"); await until(() => h.renames().length === 1); await settle();
  const event = { toolName: "bash", toolCallId: "gh-1", input: { command: 'gh pr create --title "Login" --body "Fixes login"' } };
  await h.emit("tool_call", event);
  await h.emit("tool_result", { ...event, isError: false, content: [{ type: "text", text: "https://github.com/example/repo/pull/42\n" }] });
  await until(() => h.renames().length === 2);
  assert.equal(h.pane.label, "PR #42 · Fix login"); assert.equal(h.checks.length, 1); assert.equal(h.titles.length, 1);
});

test("PR creation during generation is retained; an older task's result is discarded", async () => {
  const pending = deferred(); const h = harness({ title: () => pending.promise });
  await h.emit("session_start"); await h.send("Implement login"); await until(() => h.titles.length === 1);
  const event = { toolName: "bash", toolCallId: "gh-1", input: { command: "gh pr create" } };
  await h.emit("tool_call", event);
  await h.emit("tool_result", { ...event, isError: false, content: [{ type: "text", text: "https://github.com/example/repo/pull/42" }] });
  pending.resolve(title); await until(() => h.renames().length === 1);
  assert.equal(h.pane.label, "PR #42 · Fix login");
  await h.emit("tool_call", { ...event, toolCallId: "old-call" }); await h.send("Different task"); await settle();
  await h.emit("tool_result", { ...event, toolCallId: "old-call", isError: false, content: [{ type: "text", text: "https://github.com/example/repo/pull/99" }] });
  await settle(); assert.equal(h.pane.label?.includes("99"), false);
});

test("only the Jev credentials-file environment variable is read", () => {
  const legacy = {
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), CLOUDFLARE_AI_GATEWAY_ID: "unrelated-gateway",
    CLOUDFLARE_JEV_API_TOKEN: "unrelated-token", CLOUDFLARE_JEV_API_TOKEN_FILE: "/unrelated-token",
    CLOUDFLARE_API_TOKEN: "unrelated-token", CLOUDFLARE_API_TOKEN_FILE: "/unrelated-token",
  };
  assert.deepEqual(configuration({ ...env, ...legacy }, "google/test-model"), {
    credentialsFile: env.CLOUDFLARE_JEV_API_CREDENTIALS_FILE, provider: "google", model: "test-model",
  });
  assert.throws(() => configuration(legacy, "google/test-model"));
});

test("configuration and generated title validation fail closed", () => {
  for (const [environment, model] of [[{}, "google/test"], [env, ""], [{ ...env, CLOUDFLARE_JEV_API_CREDENTIALS_FILE: "relative" }, "google/test"]] as any) {
    assert.throws(() => configuration(environment, model));
  }
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
  assert.equal([...paneLabel({ title: "a".repeat(55), prs: ["1234567890", "2234567890", "3234567890", "4234567890"] })].length, 80);
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
  assert.deepEqual(parseTitle(JSON.stringify({ title: "🦄".repeat(55), prs: ["1", "2", "3", "4"] }), ["1", "2", "3", "4"]), {
    title: "🦄".repeat(55), prs: ["1", "2", "3", "4"],
  });
});

test("only successful direct PR-create output is recognized", () => {
  const url = "https://github.com/example/repo/pull/12";
  assert.equal(createdPR("gh pr create", url), "12");
  for (const command of ["echo gh pr create", "gh pr view", "gh pr create; echo x", "gh pr create --dry-run", "gh pr create --web", "gh pr create\nother", "gh pr create $(stuff)"]) assert.equal(createdPR(command, url), undefined);
  assert.equal(createdPR("gh pr create", `example: ${url}`), undefined);
});

test("PR switches and leaving PR work remove outdated prefixes", async () => {
  const h = harness({
    check: () => "update",
    title: (data: any) => ({ title: "Review changes", prs: data.request.includes("234") ? ["234"] : data.request.includes("123") ? ["123"] : [] }),
  });
  await h.emit("session_start");
  for (const [request, expected] of [["Review PR #123", "PR #123 · Review changes"], ["Switch to PR #234", "PR #234 · Review changes"], ["Leave PR work", "Review changes"]]) {
    await h.send(request); await until(() => h.pane.label === expected); await settle();
  }
  assert.equal(h.titles.length, 3);
});

test("Jev respects the chosen action without a confidence cutoff; invalid responses still fail closed", async () => {
  // Observed diagnostic: the old 0.8 cutoff suppressed this otherwise valid task change.
  const observed = response("new_task", 0.75);
  observed.result.result.answers.naming.probabilities = { keep: 0.03, update: 0.14, new_task: 0.81, uncertain: 0.02 };
  assert.equal(parseDecision(observed), "new_task");
  for (const choice of ["keep", "update", "new_task", "uncertain"]) {
    for (const confidence of [0, 0.75, 0.79, 1]) assert.equal(parseDecision(response(choice, confidence)), choice);
  }
  const h = harness({ label: "Pi-packages research", check: () => parseDecision(observed), title: () => ({ title: "Jev game research", prs: [] }) });
  await h.emit("session_start"); await h.command("adopt"); await h.send("Research Jev's ability to play games");
  await until(() => h.renames().length === 1);
  assert.equal(h.pane.label, "Jev game research"); assert.equal(h.checks.length, 1); assert.equal(h.titles.length, 1);
  for (const change of [
    (r: any) => { r.success = false; }, (r: any) => { r.errors = ["error"]; },
    (r: any) => { r.result.state = "Running"; }, (r: any) => { r.result.result.answers.naming.choice = "unknown"; },
    (r: any) => { r.result.result.answers.naming.probabilities.keep = 1; },
    (r: any) => { r.result.result.answers.naming.confidence = NaN; },
  ]) { const r = response(); change(r); assert.throws(() => parseDecision(r)); }
});

test("Cloudflare transport rereads JSON credentials, validates before sending, and never retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pane-naming-test-"));
  try {
    const file = join(directory, "credentials.json");
    const fileConfig = configuration({ CLOUDFLARE_JEV_API_CREDENTIALS_FILE: file }, "google/test-model");
    const signal = new AbortController().signal; let calls = 0;
    let expected: typeof credentials & { gatewayId?: string } = credentials;
    const request: typeof fetch = async (url, options) => {
      calls++; assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${expected.accountId}/ai/run`);
      assert.equal(options?.redirect, "error"); assert.equal(options?.signal, signal);
      const headers = options?.headers as Record<string, string>;
      assert.equal(headers.Authorization, `Bearer ${expected.apiToken}`);
      assert.equal(headers["cf-aig-gateway-id"], expected.gatewayId);
      assert.equal(headers["cf-aig-max-attempts"], "1"); assert.equal(headers["cf-aig-collect-log"], "false");
      const body = JSON.parse(options?.body as string);
      assert.equal(body.model, "typesafe/jev"); assert.deepEqual(body.input.state, input);
      assert.equal(JSON.stringify(body).includes(expected.apiToken), false);
      return Response.json(response());
    };
    for (expected of [credentials, { accountId: "b".repeat(32), apiToken: "rotated-token", gatewayId: "shared-gateway" }]) {
      await writeFile(file, JSON.stringify(expected));
      assert.equal(await classify(fileConfig, input, signal, request), "new_task");
    }
    assert.equal(calls, 2);
    for (const status of [401, 403, 429, 500, 503]) {
      await assert.rejects(classify(fileConfig, input, signal, async () => new Response("PRIVATE_MARKER", { status })),
        (error) => describeFailure(error) === `Jev HTTP ${status}.`);
    }
    await assert.rejects(classify(fileConfig, input, signal, async () => new Response("a".repeat(16_385))),
      (error) => describeFailure(error) === "Jev response exceeded 16 KiB.");
    await assert.rejects(classify(fileConfig, input, signal, async () => new Response("PRIVATE_MARKER invalid JSON")),
      (error) => describeFailure(error) === "Jev returned invalid JSON.");
    const invalid = [null, [], {}, { ...credentials, accountId: "../wrong" }, { ...credentials, apiToken: "Bearer secret" },
      { ...credentials, apiToken: 123 }, { ...credentials, gatewayId: "../wrong" }, { ...credentials, gatewayId: null }];
    for (const raw of [...invalid.map((value) => JSON.stringify(value)), `${credentials.apiToken} invalid JSON`]) {
      await writeFile(file, raw);
      await assert.rejects(classify(fileConfig, input, signal, request), (error: Error) => {
        assert.equal(error.message.includes(credentials.apiToken), false);
        return /credentials file/.test(error.message);
      });
    }
    await rm(file);
    await assert.rejects(classify(fileConfig, input, signal, request), /credentials file/);
    assert.equal(calls, 2, "invalid or missing credentials must not make a request");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("diagnostics retain only known error metadata and distinguish schema failures", async () => {
  assert.equal(describeFailure(new Error("PRIVATE_MARKER")), "Unexpected error (details withheld).");
  assert.equal(describeFailure(Object.assign(new Error("PRIVATE_MARKER"), { status: 429 })), "Provider HTTP 429.");
  assert.equal(describeFailure(new TypeError("fetch failed")), "Network request failed.");
  assert.equal(describeFailure(new Error("PRIVATE_MARKER", { cause: { code: "ECONNRESET" } })), "Network error (ECONNRESET).");
  assert.equal(describeFailure(new Error("PRIVATE_MARKER", { cause: { code: "PRIVATE_MARKER" } })), "Unexpected error (details withheld).");
  for (const [change, expected] of [
    [(r: any) => { r.errors = ["PRIVATE_MARKER"]; }, "Jev API reported an error or invalid envelope."],
    [(r: any) => { r.result.state = "PRIVATE_MARKER"; }, "Jev response was not Completed."],
    [(r: any) => { r.result.result.answers.naming.confidence = -1; }, "Jev returned invalid confidence."],
    [(r: any) => { r.result.result.answers.naming.probabilities.keep = "PRIVATE_MARKER"; }, "Jev returned invalid probabilities."],
    [(r: any) => { r.result.result.answers.naming.probabilities.keep = 0.1; }, "Jev probabilities did not sum to 1. Sum: 1.1; absolute deviation: 0.10000000000000009."],
    [(r: any) => { r.result.result.answers.naming.probabilities = { keep: 1, update: 0, new_task: 0, uncertain: 0 }; }, "Jev choice did not match its highest probability."],
  ] as const) {
    const value = response(); change(value);
    assert.throws(() => parseDecision(value), (error) => describeFailure(error) === expected);
  }
  for (const [result, expected] of [
    [{ stopReason: "length", errorMessage: "PRIVATE_MARKER" }, "Title model stopped with length."],
    [{ stopReason: "error", errorMessage: JSON.stringify({ error: { code: 403, message: "PRIVATE_MARKER" } }) }, "Title model HTTP 403."],
    [{ stopReason: "error", errorMessage: "PRIVATE_MARKER" }, "Title model stopped with error."],
    [{ stopReason: "PRIVATE_MARKER", errorMessage: "PRIVATE_MARKER" }, "Title model stopped with unknown."],
  ] as const) {
    const ctx: any = { modelRegistry: { find: () => ({}), streamSimple: () => ({ result: async () => result }) } };
    await assert.rejects(generateTitle(config, input, [], ctx, new AbortController().signal), (error) => describeFailure(error) === expected);
  }
});

test("deadline stops waiting even if a transport ignores its signal", async () => {
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(abortable(new Promise(() => {}), AbortSignal.timeout(5)), /timed out/);
  } finally { clearTimeout(keepAlive); }
});

test("title generation uses the selected Pi provider, no main context/tools, and bounded output", async () => {
  let captured: any; const signal = new AbortController().signal;
  const ctx: any = { modelRegistry: {
    find: (provider: string, model: string) => { assert.equal(provider, "google"); assert.equal(model, "test-model"); return { id: model }; },
    streamSimple: (_model: any, context: any, options: any) => {
      captured = { context, options }; return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(title) }] }) };
    },
  } };
  assert.deepEqual(await generateTitle(config, input, [], ctx, signal), title);
  assert.equal(captured.context.tools, undefined); assert.equal(captured.context.messages.length, 1);
  assert.equal(captured.options.maxTokens, 160); assert.equal(captured.options.maxRetries, 0); assert.equal(captured.options.reasoning, undefined);
  const controller = new AbortController(); const pending = abortable(new Promise(() => {}), controller.signal);
  controller.abort(); await assert.rejects(pending);
});
