// Smoke test for lib/claude-accounts. Run with:
//   npx tsx scripts/smoketest-accounts.mjs
// Asserts: default-account materialise → add (capture) → switch → spawnEnv
// override → remove (default refusal) → cleanup.
import {
  listAccounts,
  ensureDefaultAccount,
  viewAccounts,
  addAccount,
  setActiveAccount,
  removeAccount,
  spawnEnvOverrides,
  getActiveApiKey,
} from "../lib/claude-accounts";

console.log("before:", listAccounts().map((a) => a.name));
const def = ensureDefaultAccount();
console.log("ensureDefault:", def.id, def.credentialsDir);

console.log("view:", viewAccounts());
console.log("spawnEnv (default active):", spawnEnvOverrides());

const r = addAccount({
  name: "smoketest-" + Date.now().toString(36),
  captureFromDefault: true,
  apiKey: "sk-ant-test12345abcd",
});
console.log("added:", r.account.id, "→", r.account.credentialsDir);

setActiveAccount(r.account.id);
const env = spawnEnvOverrides();
console.log("spawnEnv after switch:", env);
if (env.CLAUDE_CONFIG_DIR !== r.account.credentialsDir) {
  console.error("FAIL: CLAUDE_CONFIG_DIR mismatch");
  process.exit(1);
}
const k = getActiveApiKey() ?? "";
console.log("apiKey tail:", k.slice(-6));

removeAccount(r.account.id);
console.log(
  "after remove:",
  viewAccounts().map((a) => a.name + (a.active ? " [active]" : "")),
);

try {
  removeAccount("default");
  console.error("FAIL: removing default should throw");
  process.exit(1);
} catch (err) {
  console.log(
    "default removal correctly rejected:",
    err instanceof Error ? err.message : String(err),
  );
}

console.log("PASS");
