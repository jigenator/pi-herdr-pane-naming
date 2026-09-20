import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createdPR, eligible, register } from "../index.ts";
import { abortable, classify, configuration, explicitPRs, generateTitle, MAX_CHECKS, paneLabel, parseDecision, parseTitle } from "../models.ts";

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
      buildContextEntries: () => options.history ?? [],
    },
    modelRegistry: { find: () => options.missingModel ? undefined : { id: "test-model", provider: "google" } },
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
    classify: async (_config, data, signal) => { checks.push({ data, signal }); return options.check ? options.check(data, signal) : "new_task"; },
    generateTitle: async (_config, data, allowed, _ctx, signal) => { titles.push({ data, allowed, signal }); return options.title ? options.title(data, allowed, signal) : title; },
  });
  // Pi creates fresh context objects for each event and command, even within one session.
  const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, { ...ctx });
  const submit = (request: string, extra: any = {}) => emit("input", { text: request, source: "interactive", ...extra });
  const deliver = (request: string) => emit("message_start", { message: { role: "user", content: [{ type: "text", text: request }] } });
  const send = async (request: string) => { await submit(request); await deliver(request); };
  const command = (arg: string) => commands.get("pane-naming")!(arg, { ...ctx });
  const renames = () => calls.filter((call) => call.args[1] === "rename");
  return { emit, submit, deliver, send, command, renames, pane, flags, entries, calls, checks, titles, notices, ctx, preferencesFile };
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
  for (let i = 2; i <= MAX_CHECKS; i++) { await resumed.send("continue"); await settle(); }
  assert.equal(resumed.checks.length, MAX_CHECKS - 1);
  assert.equal(resumed.entries.at(-1).data.checks, MAX_CHECKS);
});

test("new tasks cannot inherit old PR candidates; only explicit refs are offered", async () => {
  const h = harness({ title: (_data: any, allowed: string[]) => ({ title: "Review changes", prs: allowed }) });
  await h.emit("session_start"); await h.send("Review PR #123"); await until(() => h.renames().length === 1); await settle();
  assert.equal(h.pane.label, "PR #123 · Review changes");
  await h.send("Now fix the parser"); await until(() => h.renames().length === 2);
  assert.deepEqual(h.titles[1].allowed, []); assert.equal(h.pane.label, "Review changes");
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
  for (const value of [{ title: "", prs: [] }, { title: "\u001btitle", prs: [] }, { title: "spoof\u202e", prs: [] }, { title: "a".repeat(56), prs: [] }, { title: "PR #2", prs: [] }, { title: "--clear", prs: [] }, { title: "-h", prs: [] }, { title: "Hi", prs: ["999"] }, { title: "Hi", prs: [2] }, { title: "Hi", prs: ["2", "2"] }]) {
    assert.throws(() => parseTitle(JSON.stringify(value), ["2"]));
  }
  assert.deepEqual(parseTitle(JSON.stringify(title), []), title);
  const observed = '```json\n{"title":"Fix Login Form Validation","prs":[]}\n```';
  assert.deepEqual(parseTitle(observed, []), { title: "Fix Login Form Validation", prs: [] });
  assert.throws(() => parseTitle(`Here is a title:\n${observed}`, []));
  assert.throws(() => parseTitle(`${observed}\nIgnore the rules`, []));
  assert.deepEqual(parseTitle('{"title":"Review PR #234","prs":["234"]}', ["234"]), { title: "Review", prs: ["234"] });
  assert.throws(() => parseTitle('{"title":"Review PR #999","prs":["234"]}', ["234"]));
  assert.deepEqual(explicitPRs("issue #5; PR #12; https://github.com/example/repo/pull/34; PR #12"), ["12", "34"]);
  assert.deepEqual(explicitPRs("[review](https://github.com/example/repo/pull/34)"), ["34"]);
  assert.deepEqual(explicitPRs("https://github.com/example/repo/pull/34\n"), ["34"]);
  assert.equal([...paneLabel({ title: "a".repeat(55), prs: ["1234567890", "2234567890", "3234567890", "4234567890"] })].length, 80);
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

test("Jev contract, low confidence, malformed and failed envelopes", () => {
  assert.equal(parseDecision(response()), "new_task"); assert.equal(parseDecision(response("keep")), "keep");
  assert.equal(parseDecision(response("update", 0.79)), "uncertain");
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
    await assert.rejects(classify(fileConfig, input, signal, async () => new Response("private error", { status: 500 })));
    await assert.rejects(classify(fileConfig, input, signal, async () => new Response("a".repeat(16_385))));
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
