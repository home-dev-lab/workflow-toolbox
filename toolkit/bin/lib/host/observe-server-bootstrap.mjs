#!/usr/bin/env node

// packages/debugger/src/observe-server-bootstrap.ts
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync as existsSync2, mkdirSync, openSync, readFileSync as readFileSync2, renameSync, statSync } from "node:fs";
import { delimiter, dirname as dirname2, join as join2, resolve as resolvePath } from "node:path";
import { fileURLToPath as fileURLToPath2, pathToFileURL } from "node:url";

// packages/debugger/src/observe-checkout.ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
function findObserveRoot(cwd, env) {
  const isObserveApp = (dir2) => {
    try {
      const pkg = JSON.parse(readFileSync(join(dir2, "apps", "observe-ui", "package.json"), "utf8"));
      return typeof pkg === "object" && pkg !== null && pkg["name"] === "@workflow-toolbox/observe-ui";
    } catch {
      return false;
    }
  };
  const hasServer = (dir2) => existsSync(join(dir2, "apps", "observe-ui", "server", "dev-api.ts")) && isObserveApp(dir2);
  const probe = (dir2) => hasServer(dir2) ? dir2 : hasServer(join(dir2, "toolkit")) ? join(dir2, "toolkit") : null;
  const forced = env["DWT_OBSERVE_ROOT"];
  if (forced !== void 0 && forced.length > 0) return probe(forced);
  let dir = cwd;
  for (let depth = 0; depth < 64; depth++) {
    const hit = probe(dir) ?? probe(join(dir, "workflow-observatory"));
    if (hit !== null) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ../plugin/bin/lib/host/entry-guard.mjs
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
function isInvokedDirectly(importMetaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    const moduleUrl = new URL(importMetaUrl);
    if (moduleUrl.search || moduleUrl.hash) return false;
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// packages/debugger/src/observe-server-bootstrap.ts
async function runObserveServer() {
  const entry = resolvePath(process.argv[3]);
  process.argv.splice(1, 2);
  process.argv[1] = entry;
  try {
    process.title = "wt-observe-srv";
  } catch {
  }
  await import(pathToFileURL(entry).href);
}
function requireObserveRoot() {
  const base = findObserveRoot(process.cwd(), process.env);
  if (base === null) {
    throw new Error(
      "cannot locate the observe server (no checkout found from cwd; set DWT_OBSERVE_ROOT). Until the Workflow Observatory binary distribution ships, wt-observe start needs a workflow-observatory checkout (or a legacy workflow-toolbox one) on this machine."
    );
  }
  return base;
}
function openLogFileAt(path, rotateBytes) {
  mkdirSync(dirname2(path), { recursive: true, mode: 448 });
  try {
    if (existsSync2(path) && statSync(path).size > rotateBytes) renameSync(path, `${path}.1`);
  } catch {
  }
  return openSync(path, "a", 384);
}
function readLogSliceFrom(path, offset) {
  try {
    const buf = readFileSync2(path);
    return buf.subarray(Math.min(offset, buf.length)).toString("utf8");
  } catch {
    return "";
  }
}
function logTail(logPath, lines = 5) {
  try {
    const text = readFileSync2(logPath, "utf8");
    const tail = text.split("\n").filter(Boolean).slice(-lines).join("\n");
    return tail.length > 0 ? `log tail (${logPath}):
${tail}` : `log is empty (${logPath})`;
  } catch {
    return `log unreadable (${logPath})`;
  }
}
function serverEnvironment(port, sourceDirs, remotes, flags, token, launchAgentsDir) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: sourceDirs[0],
    OBSERVE_SOURCES: sourceDirs.join(delimiter),
    OBSERVE_UI_SERVER_PORT: String(port),
    OBSERVE_UI_TOKEN: token,
    ...remotes.length > 0 ? { OBSERVE_REMOTES: JSON.stringify(remotes) } : {},
    ...flags.enableLaunch ? { OBSERVE_UI_ENABLE_LAUNCH: "1" } : {},
    ...flags.noResume ? { OBSERVE_UI_NO_RESUME: "1" } : {},
    ...process.env["OBSERVE_LAUNCH_PLUGIN_DIRS"] === void 0 && launchAgentsDir !== null ? { OBSERVE_LAUNCH_PLUGIN_DIRS: launchAgentsDir } : {}
  };
}
function resolveTsxCli(base) {
  try {
    return createRequire(join2(base, "package.json")).resolve("tsx/cli");
  } catch {
    throw new Error(`observe base ${base} has no resolvable 'tsx' \u2014 run pnpm install in ${base}`);
  }
}
function spawnObserveChild({ base, entryUrl, port, sourceDirs, remotes, flags, token, launchAgentsDir, log }) {
  const tsxCli = resolveTsxCli(base);
  const child = spawn(process.execPath, [tsxCli, fileURLToPath2(entryUrl), "--internal-serve", "apps/observe-ui/server/dev-api.ts", ...flags.watch ? ["--watch"] : []], {
    cwd: base,
    env: serverEnvironment(port, sourceDirs, remotes, flags, token, launchAgentsDir),
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log]
  });
  let spawnError = null;
  let exited = null;
  child.once("error", (e) => {
    spawnError = e;
  });
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  child.unref();
  return { child, spawnState: () => ({ error: spawnError, exited }) };
}
export {
  isInvokedDirectly,
  logTail,
  openLogFileAt,
  readLogSliceFrom,
  requireObserveRoot,
  runObserveServer,
  spawnObserveChild
};
