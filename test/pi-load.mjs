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
const isolatedEnv = {
  PI_CODING_AGENT_DIR: temporary, HERDR_ENV: "1", HERDR_PANE_ID: "offline-pane", PI_SUBAGENT_CHILD: "0",
  CLOUDFLARE_JEV_API_CREDENTIALS_FILE: join(temporary, "unused-credentials.json"),
};
const originalEnv = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
Object.assign(process.env, isolatedEnv);
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
  assert.equal(extension.flags.get("pane-naming").default, false);
  assert.ok(extension.commands.has("pane-naming"));
  // The real loader's unbound exec is a throwing stub. Disabled startup must never call it.
  for (const mode of ["tui", "rpc", "json", "print"]) {
    const context = { mode, sessionManager: { getSessionId: () => "offline", getEntries: () => [] } };
    for (const handler of extension.handlers.get("session_start")) await handler({ reason: "startup" }, context);
    for (const handler of extension.handlers.get("session_shutdown")) await handler({ reason: "quit" }, context);
  }
  await writeFile(join(temporary, "pane-naming.json"), JSON.stringify({ enabled: true, titleModel: "google/saved-model" }));
  const selected = [];
  const context = {
    mode: "tui", sessionManager: { getSessionId: () => "offline", getEntries: () => [] },
    ui: { notify() {} },
    // Stop before Herdr/model execution; verify the real factory finds the saved model without flags.
    modelRegistry: { find(provider, model) { selected.push([provider, model]); return undefined; } },
  };
  for (const handler of extension.handlers.get("session_start")) await handler({ reason: "startup" }, context);
  assert.deepEqual(selected, [["google", "saved-model"]]);
  for (const handler of extension.handlers.get("session_shutdown")) await handler({ reason: "quit" }, context);
  console.log("PASS: installed Pi loads; saved defaults work without flags; fresh profiles stay off; no model tools or network.");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(temporary, { recursive: true, force: true });
}
