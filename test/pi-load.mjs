// Optional installed-Pi smoke check. No models, credentials, user configuration, or live panes.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = process.env.PI_PACKAGE_DIR;
assert.ok(packageDir, "Set PI_PACKAGE_DIR to the installed @earendil-works/pi-coding-agent directory.");
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(packageDir, "dist/index.js")).href);
const temporary = await mkdtemp(join(tmpdir(), "pane-naming-pi-load-"));
const originalFetch = globalThis.fetch;
// PI_CODING_AGENT_DIR also isolates pi-typesafe's key store and usage ledger.
const isolatedEnv = { PI_CODING_AGENT_DIR: temporary, HERDR_ENV: "1", HERDR_PANE_ID: "offline-pane", PI_SUBAGENT_CHILD: "0", TYPESAFE_API_KEY: undefined };
const originalEnv = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(isolatedEnv)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
globalThis.fetch = () => { throw new Error("Network prohibited during loader test"); };
try {
  const loader = new DefaultResourceLoader({
    cwd: temporary, agentDir: temporary, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(resolve(extension.path), fileURLToPath(new URL("../index.ts", import.meta.url)));
  assert.equal(extension.tools.size, 0, "Must not substitute an agent-callable rename tool");
  assert.ok(extension.commands.has("pane-naming"));

  const run = async (event, context) => { for (const handler of extension.handlers.get(event)) await handler({ reason: "startup" }, context); };
  const contextFor = (mode, selected, notices) => ({
    mode, signal: undefined,
    sessionManager: { getSessionId: () => "offline", getEntries: () => [], getBranch: () => [] },
    ui: { notify(message) { notices.push(message); } },
    model: undefined,
    // Stop before Herdr/model execution; record which title models the real factory considers.
    modelRegistry: { find(provider, model) { selected.push(`${provider}/${model}`); return undefined; } },
  });
  // The real loader's unbound exec is a throwing stub. Startup must never call Herdr or a model.
  for (const mode of ["rpc", "json", "print"]) {
    const selected = [], notices = [];
    await run("session_start", contextFor(mode, selected, notices));
    await run("session_shutdown", contextFor(mode, selected, notices));
    assert.deepEqual([selected, notices], [[], []], `${mode} stays inert`);
  }

  // A fresh profile with no preferences file starts on, with the default title model and an honest Jev warning.
  let selected = [], notices = [];
  let context = contextFor("tui", selected, notices);
  await run("session_start", context);
  assert.deepEqual(selected, ["google/gemini-3.5-flash-lite"]);
  assert.ok(notices.some((notice) => notice.includes("no title model is available")));
  assert.ok(notices.some((notice) => notice.includes("Jev is unavailable")), "missing TypeSafe key is reported, not hidden");
  await extension.commands.get("pane-naming").handler("status", context);
  assert.match(notices.at(-1), /^Pane naming on; new-pane default on\./);
  await run("session_shutdown", context);

  // A saved model is tried first; a saved global off keeps new panes off.
  await writeFile(join(temporary, "pane-naming.json"), JSON.stringify({ enabled: false, titleModel: "google/saved-model", cooldownSeconds: 5, checkLimit: 7 }));
  selected = []; notices = [];
  context = contextFor("tui", selected, notices);
  await run("session_start", context);
  await extension.commands.get("pane-naming").handler("status", context);
  assert.match(notices.at(-1), /^Pane naming off; new-pane default off\./);
  assert.ok(notices.at(-1).includes("Cooldown: 5s"));
  assert.equal(selected[0], "google/saved-model");
  await run("session_shutdown", context);
  console.log("PASS: installed Pi loads; fresh profiles start on; saved off and saved model are honoured; no model tools or network.");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(temporary, { recursive: true, force: true });
}
