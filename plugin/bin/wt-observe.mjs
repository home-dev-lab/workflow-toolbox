#!/usr/bin/env node

// packages/debugger/src/observe-cli.ts
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync as readdirSync3, realpathSync as realpathSync2, renameSync as renameSync3, rmSync as rmSync2, statSync as statSync2, unlinkSync as unlinkSync3, writeFileSync as writeFileSync3, openSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { delimiter, dirname, join as join5, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// packages/debugger/src/observe-lifecycle.ts
import { join } from "node:path";
function xdgOverride(env, name) {
  const v = env[name];
  return v !== void 0 && v.length > 0 ? v : null;
}
function observeStateRoot(env, home, platform) {
  const xdg = xdgOverride(env, "XDG_STATE_HOME");
  const base = xdg !== null ? xdg : platform === "darwin" ? join(home, "Library", "Application Support") : platform === "win32" ? xdgOverride(env, "LOCALAPPDATA") ?? join(home, "AppData", "Local") : join(home, ".local", "state");
  return join(base, "wt-observe");
}
function observeConfigRoot(env, home, platform) {
  const xdg = xdgOverride(env, "XDG_CONFIG_HOME");
  const base = xdg !== null ? xdg : platform === "darwin" ? join(home, "Library", "Preferences") : platform === "win32" ? xdgOverride(env, "APPDATA") ?? join(home, "AppData", "Roaming") : join(home, ".config");
  return join(base, "wt-observe");
}
function parseSysctlBoottimeSec(output) {
  const m = /sec\s*=\s*(\d+)/.exec(output);
  return m !== null ? Number(m[1]) : null;
}
function parsePsLstartEpochSec(output) {
  const t = output.trim();
  if (t.length === 0) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? Math.floor(ms / 1e3) : null;
}
function parsePowershellInt(output) {
  const t = output.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}
function observeServerPidfilePath(stateRoot) {
  return join(stateRoot, "server.json");
}
function observeServerLogPath(stateRoot) {
  return join(stateRoot, "server.log");
}
function withCarriedToken(next, prior) {
  if (next.token !== void 0) return next;
  if (prior?.token === void 0) return next;
  return { ...next, token: prior.token };
}
function serializeObservePidfile(pf) {
  return JSON.stringify(pf);
}
function parseObservePidfile(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw;
  if (typeof m["pid"] !== "number" || typeof m["port"] !== "number") return null;
  if (typeof m["configDir"] !== "string" || typeof m["startedAt"] !== "string") return null;
  if (m["bootId"] !== null && typeof m["bootId"] !== "string") return null;
  if (m["procStartTicks"] !== null && typeof m["procStartTicks"] !== "number") return null;
  if (m["token"] !== void 0 && typeof m["token"] !== "string") return null;
  if (!Array.isArray(m["sources"]) || m["sources"].length === 0 || m["sources"].some((s) => typeof s !== "string")) return null;
  return raw;
}
function dedupe(paths) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}
function resolveHubSources(explicit, configSources, discoveryCandidates, exists, canonicalize) {
  if (explicit.length > 0) return dedupe(explicit.map(canonicalize));
  if (configSources.length > 0) return dedupe(configSources.map(canonicalize).filter(exists));
  return dedupe(discoveryCandidates.map(canonicalize).filter(exists));
}
function classifyHealth(h) {
  if (h === "no-listener") return "unreachable";
  if (h === "not-ours") return "foreign";
  if (h === "timeout") return "inconclusive";
  return "ours";
}
function decideStart(probe) {
  if (probe.pidfile === null) {
    if (probe.health === "ours") return { action: "adopt" };
    if (probe.health === "foreign" || probe.health === "inconclusive") return { action: "start-free-port" };
    return { action: "start" };
  }
  if (!probe.pidAlive || !probe.pidIdentityMatches) return { action: "clear-stale" };
  if (probe.health === "ours") return { action: "adopt" };
  if (probe.health === "inconclusive") return { action: "retry-health" };
  return { action: "kill-zombie", pid: probe.pidfile.pid };
}
function decideStop(probe) {
  if (probe.pidfile === null) return { action: "noop" };
  if (!probe.pidAlive || !probe.pidIdentityMatches) return { action: "clear" };
  return { action: "kill", pid: probe.pidfile.pid };
}
var ADD_REMOTE_USAGE = "usage: wt-observe config add-remote <url> [--token <t> | --token-file <path>] [--label <label>]";
var ADD_REMOTE_FLAGS = {
  "--token": "token",
  "--token-file": "tokenFile",
  "--label": "label"
};
function parseConfigAction(rest) {
  const sub = rest[0];
  if (sub === void 0 || sub === "show") return { action: "show" };
  if (sub === "add-source" || sub === "remove-source") {
    const dir = rest[1];
    if (dir === void 0) return { action: "invalid", message: `usage: wt-observe config ${sub} <dir>` };
    return { action: sub, dir };
  }
  if (sub === "add-remote") {
    const url = rest[1];
    if (url === void 0 || url.startsWith("--")) return { action: "invalid", message: ADD_REMOTE_USAGE };
    const out = { action: "add-remote", url };
    for (let i = 2; i < rest.length; i += 2) {
      const flag = rest[i];
      const field = ADD_REMOTE_FLAGS[flag];
      if (field === void 0) return { action: "invalid", message: `config add-remote: unknown flag "${flag}"` };
      const value = rest[i + 1];
      if (value === void 0) return { action: "invalid", message: `config add-remote: ${flag} requires a value` };
      out[field] = value;
    }
    if (out.token !== void 0 && out.tokenFile !== void 0) {
      return { action: "invalid", message: "config add-remote: pass --token OR --token-file, not both" };
    }
    return out;
  }
  if (sub === "remove-remote") {
    const url = rest[1];
    if (url === void 0) return { action: "invalid", message: "usage: wt-observe config remove-remote <url>" };
    return { action: "remove-remote", url };
  }
  return {
    action: "invalid",
    message: `unknown \`wt-observe config\` action "${sub}" (expected show|add-source|remove-source|add-remote|remove-remote)`
  };
}
function normalizeRemoteUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// packages/debugger/src/launch-enable-state.ts
import * as fs from "node:fs";
import { join as join3 } from "node:path";

// packages/debugger/src/config-dir.ts
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2, resolve } from "node:path";
function resolveDir(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
function resolveConfigDir(env = process.env) {
  const raw = env["CLAUDE_CONFIG_DIR"];
  return resolveDir(raw !== void 0 && raw.length > 0 ? raw : join2(homedir(), ".claude"));
}

// packages/debugger/src/launch-enable-state.ts
function launchEnableStateDir(stateRoot) {
  return join3(stateRoot, "launch-enable");
}
function clearAllLaunchEnableRecords(stateRoot) {
  const dir = launchEnableStateDir(stateRoot);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      fs.unlinkSync(join3(dir, name));
    } catch {
    }
  }
}

// packages/debugger/src/observe-identity.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
function probeExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 3e3, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
function readBootId() {
  if (process.platform === "darwin") {
    const out = probeExec("sysctl", ["-n", "kern.boottime"]);
    const sec = out !== null ? parseSysctlBoottimeSec(out) : null;
    return sec !== null ? `boottime-${String(sec)}` : null;
  }
  if (process.platform === "win32") {
    const out = probeExec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[DateTimeOffset]::new((Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeSeconds()"
    ]);
    const sec = out !== null ? parsePowershellInt(out) : null;
    return sec !== null ? `boottime-${String(sec)}` : null;
  }
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}
function readProcStartStamp(pid) {
  if (process.platform === "darwin") {
    const out = probeExec("ps", ["-p", String(pid), "-o", "lstart="]);
    return out !== null ? parsePsLstartEpochSec(out) : null;
  }
  if (process.platform === "win32") {
    const out = probeExec("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[DateTimeOffset]::new((Get-Process -Id ${String(pid)}).StartTime).ToUnixTimeSeconds()`
    ]);
    return out !== null ? parsePowershellInt(out) : null;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(rest[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

// packages/debugger/src/observe-config.ts
import { mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, statSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
var CONFIG_FILENAME = "config.json";
function readObserveConfig(configRoot) {
  let raw;
  try {
    raw = JSON.parse(readFileSync2(join4(configRoot, CONFIG_FILENAME), "utf8"));
  } catch {
    return { sources: [], remotes: [] };
  }
  if (typeof raw !== "object" || raw === null) return { sources: [], remotes: [] };
  const obj = raw;
  const rawSources = obj["sources"];
  const sources = Array.isArray(rawSources) ? rawSources.filter((s) => typeof s === "string" && s.trim().length > 0) : [];
  const rawRemotes = obj["remotes"];
  const remotes = Array.isArray(rawRemotes) ? rawRemotes.map(parseRemoteEntry).filter((e) => e !== null) : [];
  return { sources, remotes };
}
function parseRemoteEntry(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw;
  const url = obj["url"];
  if (typeof url !== "string" || url.trim().length === 0) return null;
  const entry = { url };
  for (const field of ["token", "tokenFile", "label"]) {
    const value = obj[field];
    if (typeof value === "string" && value.trim().length > 0) entry[field] = value;
  }
  return entry;
}
function writeObserveConfig(configRoot, config) {
  mkdirSync2(configRoot, { recursive: true, mode: 448 });
  const path = join4(configRoot, CONFIG_FILENAME);
  const tmpPath = join4(configRoot, `.${CONFIG_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync2(tmpPath, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
    renameSync2(tmpPath, path);
  } catch (e) {
    try {
      unlinkSync2(tmpPath);
    } catch {
    }
    throw e;
  }
}
var CLAUDE_DIR_NAME = /^\.claude(-.+)?$/;
function hasProjectsStore(candidate) {
  try {
    return statSync(join4(candidate, "projects")).isDirectory();
  } catch {
    return false;
  }
}
function discoverConfigDirCandidates(env, home) {
  const candidates = [];
  const explicit = env["CLAUDE_CONFIG_DIR"];
  if (explicit !== void 0 && explicit.length > 0) candidates.push(explicit);
  try {
    const siblings = readdirSync2(home, { withFileTypes: true }).filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && CLAUDE_DIR_NAME.test(entry.name)).map((entry) => entry.name).sort();
    for (const name of siblings) candidates.push(join4(home, name));
  } catch {
    candidates.push(join4(home, ".claude"));
  }
  return candidates.filter(hasProjectsStore);
}

// packages/debugger/src/observe-await.ts
var NON_TERMINAL = /* @__PURE__ */ new Set(["running", "pending"]);
function classifyAwaitTick(obs) {
  if (obs.live !== null) {
    if (obs.live.finished) {
      const s = obs.live.status;
      return { kind: "done", status: s === null || NON_TERMINAL.has(s) ? "unknown" : s };
    }
    if (obs.elapsedMs > obs.timeoutMs) return { kind: "timeout" };
    return { kind: "pending" };
  }
  if (obs.recallStatus !== null && !NON_TERMINAL.has(obs.recallStatus)) {
    return { kind: "done", status: obs.recallStatus };
  }
  if (obs.elapsedMs > obs.timeoutMs) return { kind: "timeout" };
  if (obs.recallStatus !== null) return { kind: "pending" };
  return obs.elapsedMs > obs.missingGraceMs ? { kind: "missing" } : { kind: "pending" };
}
function extractAwaitOutcome(recall) {
  if (typeof recall !== "object" || recall === null) return { status: null, result: null };
  const r = recall;
  const status = typeof r["status"] === "string" ? r["status"] : null;
  const io = r["io"];
  const result = typeof io === "object" && io !== null ? io["result"] ?? null : null;
  return { status, result };
}
function awaitExitCode(verdict) {
  if (verdict.kind === "timeout") return 3;
  if (verdict.kind === "missing") return 4;
  return verdict.status === "completed" ? 0 : 2;
}

// packages/debugger/src/observe-prune.ts
var DEFAULT_TEST_PREFIXES = ["probe-", "_probe-", "_test-"];
function selectRuns(records, criteria) {
  if (criteria.runId) return records.filter((r) => r.runId === criteria.runId);
  const prefixes = criteria.namePrefixes && criteria.namePrefixes.length > 0 ? criteria.namePrefixes : DEFAULT_TEST_PREFIXES;
  const hasAge = typeof criteria.olderThanMs === "number" && criteria.olderThanMs >= 0;
  return records.filter((r) => {
    const nameOk = r.name != null && prefixes.some((p) => r.name.startsWith(p));
    const ageOk = !hasAge || criteria.nowMs - r.mtimeMs >= criteria.olderThanMs;
    return nameOk && ageOk;
  });
}
function runNameFromScript(scriptFilename, runId) {
  const suffix = `-${runId}.js`;
  if (!scriptFilename.endsWith(suffix)) return null;
  const name = scriptFilename.slice(0, -suffix.length);
  return name.length > 0 ? name : null;
}
function parseDurationMs(input) {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(input.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[unit];
  return n * mult;
}
function pathsToDelete(record) {
  return [record.jsonPath, record.scriptPath, record.sidecarDir].filter((p) => typeof p === "string");
}

// packages/debugger/src/observe-cli.ts
var DEFAULT_PORT = 5174;
var HEALTH_TIMEOUT_MS = 2e3;
var SPAWN_READY_TIMEOUT_MS = 3e4;
var LOG_ROTATE_BYTES = 5 * 1024 * 1024;
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function pidState(pf) {
  const alive = pf !== null && pidAlive(pf.pid);
  return { alive, idMatch: pf !== null && alive && pidIdentityMatches(pf) };
}
function pidIdentityMatches(pf) {
  if (pf.bootId === null || pf.procStartTicks === null) return false;
  return readBootId() === pf.bootId && readProcStartStamp(pf.pid) === pf.procStartTicks;
}
async function probeHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return "not-ours";
    const body = await res.json();
    if (typeof body !== "object" || body === null) return "not-ours";
    const h = body;
    if (h["app"] !== "observe-ui") return "not-ours";
    if (typeof h["pid"] !== "number" || typeof h["port"] !== "number") return "not-ours";
    if (typeof h["startedAt"] !== "string") return "not-ours";
    const hasConfigDir = typeof h["configDir"] === "string";
    const hasSources = Array.isArray(h["sources"]);
    if (!hasConfigDir && !hasSources) return "not-ours";
    if (h["port"] !== port) return "not-ours";
    return h;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") return "timeout";
    const cause = err.cause;
    return cause?.code === "ECONNREFUSED" ? "no-listener" : "not-ours";
  }
}
async function probeFreePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => port > 0 ? resolvePort(port) : reject(new Error("no port assigned")));
    });
  });
}
function findObserveRoot(cwd, env) {
  const isObserveApp = (d) => {
    try {
      const pkg = JSON.parse(readFileSync3(join5(d, "apps", "observe-ui", "package.json"), "utf8"));
      return typeof pkg === "object" && pkg !== null && pkg["name"] === "@workflow-toolbox/observe-ui";
    } catch {
      return false;
    }
  };
  const hasServer = (d) => existsSync2(join5(d, "apps", "observe-ui", "server", "dev-api.ts")) && isObserveApp(d);
  const probe = (d) => hasServer(d) ? d : hasServer(join5(d, "toolkit")) ? join5(d, "toolkit") : null;
  const forced = env["DWT_OBSERVE_ROOT"];
  if (forced !== void 0 && forced.length > 0) return probe(forced);
  let dir = cwd;
  for (let depth = 0; depth < 64; depth++) {
    const hit = probe(dir) ?? probe(join5(dir, "workflow-observatory"));
    if (hit !== null) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
function openLogFileAt(path) {
  mkdirSync3(dirname(path), { recursive: true, mode: 448 });
  try {
    if (existsSync2(path) && statSync2(path).size > LOG_ROTATE_BYTES) {
      renameSync3(path, `${path}.1`);
    }
  } catch {
  }
  return openSync(path, "a", 384);
}
function readPidfileAt(path) {
  try {
    return parseObservePidfile(readFileSync3(path, "utf8"));
  } catch {
    return null;
  }
}
function writePidfileAt(path, pf) {
  mkdirSync3(dirname(path), { recursive: true, mode: 448 });
  writeFileSync3(path, serializeObservePidfile(pf), { mode: 384 });
}
function clearPidfileAt(path) {
  try {
    unlinkSync3(path);
  } catch {
  }
}
function clearLegacyHubPidfile(stateRoot) {
  try {
    unlinkSync3(join5(stateRoot, "hub.json"));
  } catch {
  }
}
function sourcesFromHealth(h) {
  if (Array.isArray(h.sources)) return h.sources.map((s) => s.configDir);
  return typeof h.configDir === "string" ? [h.configDir] : [];
}
function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
function pidfileFromHealth(h) {
  const sources = sourcesFromHealth(h);
  return {
    pid: h.pid,
    port: h.port,
    configDir: sources[0],
    bootId: readBootId(),
    procStartTicks: readProcStartStamp(h.pid),
    startedAt: h.startedAt,
    sources
  };
}
function makeCtx() {
  const stateRoot = observeStateRoot(process.env, homedir2(), process.platform);
  return { stateRoot, pidfilePath: observeServerPidfilePath(stateRoot) };
}
async function probeFor(ctx) {
  const pf = readPidfileAt(ctx.pidfilePath);
  const port = pf?.port ?? Number(process.env["OBSERVE_UI_SERVER_PORT"] ?? DEFAULT_PORT);
  const probed = await probeHealth(port);
  const { alive, idMatch } = pidState(pf);
  return {
    pf,
    health: typeof probed === "object" ? probed : null,
    identity: classifyHealth(probed),
    alive,
    idMatch,
    port
  };
}
function resolveStartSources(explicitRaw) {
  const explicit = explicitRaw.map(resolveDir);
  for (const [i, dir] of explicit.entries()) {
    if (!existsSync2(dir)) throw new Error(`--source ${explicitRaw[i]}: directory does not exist (resolved to ${dir})`);
  }
  const configRoot = observeConfigRoot(process.env, homedir2(), process.platform);
  const { sources: configSources } = readObserveConfig(configRoot);
  const discoveryCandidates = discoverConfigDirCandidates(process.env, homedir2());
  const resolved = resolveHubSources(explicit, configSources, discoveryCandidates, existsSync2, resolveDir);
  if (resolved.length > 0) return resolved;
  const fallback = resolveConfigDir();
  if (configSources.length > 0 || discoveryCandidates.length > 0) {
    process.stderr.write(
      `note: no configured/discovered source still resolves \u2014 falling back to ${fallback}. Run \`wt-observe config show\` to see why.
`
    );
  }
  return [fallback];
}
function resolveStartRemotes() {
  const configRoot = observeConfigRoot(process.env, homedir2(), process.platform);
  const { remotes } = readObserveConfig(configRoot);
  const valid = [];
  for (const remote of remotes) {
    if (normalizeRemoteUrl(remote.url) === null) {
      process.stderr.write(`note: skipping configured remote "${remote.url}" \u2014 not a usable http(s) URL (\`wt-observe config show\`).
`);
    } else {
      valid.push(remote);
    }
  }
  return valid;
}
function resolveLaunchAgentsDir() {
  let selfDir;
  try {
    selfDir = dirname(realpathSync2(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
  for (const rel of ["../launch-agents", "../../../../plugin/launch-agents"]) {
    const candidate = resolvePath(selfDir, rel);
    if (existsSync2(join5(candidate, ".claude-plugin", "plugin.json"))) return candidate;
  }
  return null;
}
async function spawnServer(stateRoot, port, sourceDirs, remotes, flags) {
  const base = findObserveRoot(process.cwd(), process.env);
  if (base === null) {
    throw new Error(
      "cannot locate the observe server (no checkout found from cwd; set DWT_OBSERVE_ROOT). Until the Workflow Observatory binary distribution ships, wt-observe start needs a workflow-observatory checkout (or a legacy workflow-toolbox one) on this machine."
    );
  }
  const logPath = observeServerLogPath(stateRoot);
  const log = openLogFileAt(logPath);
  const token = randomBytes(24).toString("hex");
  const launchAgentsDir = resolveLaunchAgentsDir();
  const tsxCli = (() => {
    try {
      return createRequire(join5(base, "package.json")).resolve("tsx/cli");
    } catch {
      throw new Error(`observe base ${base} has no resolvable 'tsx' \u2014 run pnpm install in ${base}`);
    }
  })();
  const child = spawn(process.execPath, [tsxCli, "apps/observe-ui/server/dev-api.ts", ...flags.watch ? ["--watch"] : []], {
    cwd: base,
    env: {
      ...process.env,
      // Both env vars are set regardless of cardinality: dev-api.ts only switches to
      // multi-source mode when OBSERVE_SOURCES resolves to 2+ UNIQUE entries (its own
      // `parsedSources.length >= 2` check) — with exactly 1 resolved source it falls
      // straight through to CLAUDE_CONFIG_DIR, so setting both here is always correct and
      // needs no cardinality branch on this side either.
      CLAUDE_CONFIG_DIR: sourceDirs[0],
      // path.delimiter, not ':' — a colon inside 'C:\...' would shred Windows paths;
      // dev-api.ts splits with the same constant (same machine, same value).
      OBSERVE_SOURCES: sourceDirs.join(delimiter),
      OBSERVE_UI_SERVER_PORT: String(port),
      OBSERVE_UI_TOKEN: token,
      // Remote-hub mounts (hub federation) — JSON, not delimiter-joined: URLs carry
      // colons everywhere. Only set when configured, so a remote-less start's env is
      // byte-identical to before.
      ...remotes.length > 0 ? { OBSERVE_REMOTES: JSON.stringify(remotes) } : {},
      ...flags.enableLaunch ? { OBSERVE_UI_ENABLE_LAUNCH: "1" } : {},
      // The agents-only shim plugin the server loads into every DELEGATED SDK
      // session (SDK `plugins` option), so `workflow-toolbox:lean`/`leaf` resolve
      // there despite the sessions' deliberate `settingSources: []` (without it
      // the fences always probe "not found" and degrade — found live 2026-07-13).
      // An explicit user-set value wins; absent shim (older checkout) = unset,
      // the server then launches exactly as before.
      ...process.env["OBSERVE_LAUNCH_PLUGIN_DIRS"] === void 0 && launchAgentsDir !== null ? { OBSERVE_LAUNCH_PLUGIN_DIRS: launchAgentsDir } : {}
    },
    detached: true,
    windowsHide: true,
    // win32: detached must not flash a console window
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
  const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS;
  for (; ; ) {
    if (spawnError !== null) {
      throw new Error(`failed to spawn the server: ${spawnError.message}`);
    }
    if (exited !== null) {
      const e = exited;
      throw new Error(
        `server exited immediately (code ${e.code ?? "null"}${e.signal ? `, signal ${e.signal}` : ""}).
${logTail(logPath)}`
      );
    }
    const h = await probeHealth(port);
    if (typeof h === "object" && (Array.isArray(h.sources) || typeof h.configDir === "string")) return { health: h, token };
    if (Date.now() > deadline) {
      throw new Error(`server did not become healthy on :${port} within ${SPAWN_READY_TIMEOUT_MS} ms.
${logTail(logPath)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
function logTail(logPath, lines = 5) {
  try {
    const text = readFileSync3(logPath, "utf8");
    const tail = text.split("\n").filter(Boolean).slice(-lines).join("\n");
    return tail.length > 0 ? `log tail (${logPath}):
${tail}` : `log is empty (${logPath})`;
  } catch {
    return `log unreadable (${logPath})`;
  }
}
async function cmdStart(ctx, sourceDirs, remotes, flags) {
  for (let round = 0; round < 3; round++) {
    const p = await probeFor(ctx);
    const d = decideStart({ pidfile: p.pf, pidAlive: p.alive, pidIdentityMatches: p.idMatch, health: p.identity });
    if (d.action === "adopt") {
      const h2 = p.health;
      const served = sourcesFromHealth(h2);
      writePidfileAt(ctx.pidfilePath, withCarriedToken(pidfileFromHealth(h2), p.pf));
      const label2 = served.length === 1 ? ` for ${served[0]}` : "";
      const sourcesLine2 = served.length > 1 ? `sources: ${served.join(", ")}
` : "";
      process.stdout.write(`observe-ui already running${label2} \u2014 adopted.
${sourcesLine2}URL: http://127.0.0.1:${h2.port}/
`);
      if (!sameSet(served, sourceDirs)) {
        process.stderr.write(
          `note: the running server serves ${served.join(", ")}, not the requested ${sourceDirs.join(", ")} \u2014 \`wt-observe stop\` then \`start\` to apply the new set.
`
        );
      }
      if (flags.watch) process.stderr.write("note: --watch ignored (adopted a running server). `wt-observe stop` then `start --watch` to get the watcher.\n");
      if (flags.enableLaunch && h2.launchEnabled !== true) {
        if (sourceDirs.length > 1) {
          process.stderr.write(
            "note: --enable-launch not retrofitted on an adopted multi-source server (launches are per-source; no server-wide toggle). `wt-observe stop` then `start --enable-launch` to enable at boot.\n"
          );
        } else if (!p.idMatch) {
          process.stderr.write("note: --enable-launch skipped \u2014 the running server's process identity does not verify against the pidfile; `wt-observe stop` then `start --enable-launch`.\n");
        } else {
          const token2 = readPidfileAt(ctx.pidfilePath)?.token;
          if (token2 === void 0) {
            process.stderr.write("note: --enable-launch skipped \u2014 no token recorded for this server (restart with `wt-observe stop` then `start --enable-launch`).\n");
          } else {
            try {
              const res = await fetch(`http://127.0.0.1:${h2.port}/api/launch-enable`, {
                method: "POST",
                headers: { "x-observe-token": token2 },
                signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
              });
              if (res.ok) process.stdout.write("live launches ENABLED on the adopted server (runtime opt-in).\n");
              else process.stderr.write(`note: --enable-launch failed (HTTP ${res.status}) \u2014 enable from the UI or restart with the flag.
`);
            } catch (e) {
              process.stderr.write(`note: --enable-launch failed (${e instanceof Error ? e.message : String(e)}) \u2014 enable from the UI or restart with the flag.
`);
            }
          }
        }
      }
      return;
    }
    if (d.action === "kill-zombie") {
      process.stderr.write(`wt-observe: owned server (pid ${d.pid}) is wedged \u2014 SIGTERM, restarting\u2026
`);
      try {
        process.kill(d.pid, "SIGTERM");
      } catch {
      }
      clearPidfileAt(ctx.pidfilePath);
      await new Promise((r) => setTimeout(r, 1e3));
      continue;
    }
    if (d.action === "clear-stale") {
      clearPidfileAt(ctx.pidfilePath);
      clearLegacyHubPidfile(ctx.stateRoot);
      continue;
    }
    if (d.action === "retry-health") {
      process.stderr.write("wt-observe: owned server slow to answer \u2014 retrying health with a longer timeout\u2026\n");
      const h2 = await probeHealth(p.port, 1e4);
      if (typeof h2 === "object") {
        writePidfileAt(ctx.pidfilePath, withCarriedToken(pidfileFromHealth(h2), p.pf));
        process.stdout.write(`observe-ui already running (answered on retry) \u2014 adopted.
URL: http://127.0.0.1:${h2.port}/
`);
        return;
      }
      throw new Error(
        `owned server (pid ${p.pf?.pid ?? "?"}) is alive but not answering /api/health on :${p.port} \u2014 busy or wedged. Retry shortly, or run \`wt-observe stop\` then \`start\` to force-restart it.`
      );
    }
    const port = d.action === "start-free-port" ? await probeFreePort() : p.port;
    const { health: h, token } = await spawnServer(ctx.stateRoot, port, sourceDirs, remotes, flags);
    writePidfileAt(ctx.pidfilePath, { ...pidfileFromHealth(h), token });
    const notes = [flags.watch ? " with the vite build watcher (--watch)" : "", flags.enableLaunch ? " with live launches ENABLED (--enable-launch)" : ""].join("");
    const label = sourceDirs.length === 1 ? ` for ${sourceDirs[0]}` : "";
    const sourcesLine = sourceDirs.length > 1 ? `sources: ${sourceDirs.join(", ")}
` : "";
    process.stdout.write(`observe-ui started${label} (pid ${h.pid})${notes}.
${sourcesLine}URL: http://127.0.0.1:${h.port}/
`);
    return;
  }
  throw new Error("start did not converge after 3 rounds \u2014 check `wt-observe status` and the state dir");
}
async function cmdStop(ctx) {
  clearLegacyHubPidfile(ctx.stateRoot);
  const pf = readPidfileAt(ctx.pidfilePath);
  const { alive, idMatch } = pidState(pf);
  const d = decideStop({ pidfile: pf, pidAlive: alive, pidIdentityMatches: idMatch });
  if (d.action === "noop") {
    process.stdout.write("no observe-ui pidfile \u2014 nothing to stop.\n");
    return;
  }
  if (d.action === "kill") {
    try {
      process.kill(d.pid, "SIGTERM");
      process.stdout.write(`stopped observe-ui (pid ${d.pid}).
`);
    } catch {
      process.stdout.write(`observe-ui (pid ${d.pid}) was already gone.
`);
    }
  } else {
    process.stdout.write("stale pidfile (pid dead or recycled) \u2014 cleared, nothing signalled.\n");
  }
  clearPidfileAt(ctx.pidfilePath);
  clearAllLaunchEnableRecords(ctx.stateRoot);
}
async function cmdStatus(ctx) {
  const p = await probeFor(ctx);
  process.stdout.write(`pidfile    : ${ctx.pidfilePath}${p.pf === null ? " (absent)" : ""}
`);
  if (p.pf !== null) {
    process.stdout.write(`recorded   : pid ${p.pf.pid} port ${p.pf.port} startedAt ${p.pf.startedAt}
`);
    process.stdout.write(`pid state  : ${p.alive ? p.idMatch ? "alive (identity OK)" : "alive but RECYCLED (identity mismatch)" : "dead"}
`);
    process.stdout.write("recorded sources:\n");
    for (const s of p.pf.sources) process.stdout.write(`  - ${s}
`);
  }
  if (p.identity === "ours" && p.health !== null) {
    process.stdout.write(`health :${p.port} \u2192 ours \u2014 pid ${p.health.pid}, up since ${p.health.startedAt}
`);
    if (p.health.claude !== void 0) {
      const v = p.health.claudeVersion != null ? ` (v${p.health.claudeVersion})` : "";
      process.stdout.write(`claude     : ${p.health.claude ?? "SDK bundled fallback"}${v}
`);
    }
    if (p.health.launchEnabled !== void 0) {
      process.stdout.write(`launches   : ${p.health.launchEnabled ? "ENABLED (live-launch opt-in active)" : "disabled (start --enable-launch, or the UI Launch opt-in)"}
`);
    }
    if (Array.isArray(p.health.sources)) {
      process.stdout.write("sources    :\n");
      for (const s of p.health.sources) process.stdout.write(`  - ${s.key}  ${s.configDir}
`);
    } else if (typeof p.health.configDir === "string") {
      process.stdout.write(`config dir : ${p.health.configDir}
`);
    }
    process.stdout.write(`URL        : http://127.0.0.1:${p.health.port}/
`);
  } else if (p.identity === "foreign") {
    process.stdout.write(`health :${p.port} \u2192 FOREIGN \u2014 no health identity (old build or unrelated process)
`);
  } else if (p.identity === "inconclusive") {
    process.stdout.write(`health :${p.port} \u2192 INCONCLUSIVE (listener accepted but timed out \u2014 busy server?)
`);
  } else {
    process.stdout.write(`health :${p.port} \u2192 unreachable (port free)
`);
  }
}
async function requireOwnedServer(ctx) {
  const p = await probeFor(ctx);
  if (p.identity !== "ours" || p.health === null) {
    throw new Error(`no owned observe-ui server (health on :${p.port} \u2192 ${p.identity}). Run \`wt-observe start\` first.`);
  }
  if (!p.idMatch) {
    throw new Error(
      "server answers as ours but its recorded process identity does not verify (stale pidfile, recycled pid, or a platform without /proc identity) \u2014 refusing to send the API token. `wt-observe stop` then `start` to re-establish identity."
    );
  }
  const token = p.pf?.token;
  if (token === void 0) {
    throw new Error("owned server found but no token recorded in the pidfile \u2014 `wt-observe stop` then `start` to mint one.");
  }
  return { port: p.health.port, token };
}
async function api(port, token, path, init = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "x-observe-token": token, ...init.body !== void 0 ? { "content-type": "application/json" } : {}, ...init.headers ?? {} },
    signal: AbortSignal.timeout(timeoutMs)
  });
}
async function resolveSourcePrefix(port, token, wanted) {
  const body = await api(port, token, "/api/sources", {}, 1e4).then((r) => r.ok ? r.json() : null).catch(() => null);
  const raw = typeof body === "object" && body !== null ? body["sources"] : void 0;
  const sources = Array.isArray(raw) ? raw : null;
  if (sources === null || sources.length === 0) return { prefix: "", label: "" };
  const pick = wanted === void 0 ? sources[0] : sources.find(
    (s) => s.key === wanted || s.label === wanted || typeof s.configDir === "string" && (s.configDir === wanted || s.configDir.endsWith(`/${wanted}`))
  );
  if (pick === void 0) {
    throw new Error(
      `--source ${String(wanted)} matches no hub source \u2014 available: ${sources.map((s) => `${s.label ?? s.key} (${s.configDir ?? "remote"})`).join(", ")}`
    );
  }
  return { prefix: `/s/${pick.key}`, label: pick.label ?? pick.key };
}
async function cmdLaunch(ctx, script, rawArgs, sourceFlag) {
  if (script === void 0) throw new Error("usage: wt-observe launch <workflow.js> [--args <json>] [--source <label|dir>]");
  let args;
  if (rawArgs !== void 0) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      throw new Error(`--args is not valid JSON: ${rawArgs}`);
    }
  }
  const { port, token } = await requireOwnedServer(ctx);
  const { prefix, label } = await resolveSourcePrefix(port, token, sourceFlag);
  if (label !== "") process.stderr.write(`launching under source ${label}
`);
  const res = await api(port, token, `${prefix}/api/launch`, { method: "POST", body: JSON.stringify({ script, ...args !== void 0 ? { args } : {} }) }, 3e4);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof body === "object" && body !== null ? body["code"] : void 0;
    let hint = "";
    if (res.status === 404) {
      const list = await api(port, token, `${prefix}/api/workflows`).then((r) => r.json(), () => []);
      if (list.length > 0) hint = `
available: ${list.map((w) => w.id).join(", ")}`;
    }
    if (res.status === 403 && code === "launch-disabled") hint = "\nlive launches are disabled \u2014 `wt-observe start --enable-launch` (or the UI Launch opt-in).";
    else if (res.status === 403) hint = "\ntoken rejected \u2014 the pidfile token no longer matches the server; `wt-observe stop` then `start` to re-mint.";
    const msg = typeof body === "object" && body !== null ? String(body["error"] ?? res.status) : String(res.status);
    throw new Error(`launch failed: ${msg}${hint}`);
  }
  process.stdout.write(`${JSON.stringify(body)}
`);
}
var AWAIT_DEFAULT_TIMEOUT_S = 7200;
var AWAIT_DEFAULT_POLL_S = 3;
var AWAIT_MISSING_GRACE_MS = 3e4;
var AWAIT_SETTLE_TRIES = 10;
var AWAIT_SETTLE_INTERVAL_MS = 1e3;
async function fetchRecall(port, token, prefix, runId) {
  return api(port, token, `${prefix}/api/runs/${encodeURIComponent(runId)}`, {}, 1e4).then((r) => r.ok ? r.json() : null).catch(() => null);
}
async function cmdAwait(ctx, runId, timeoutS, pollS, sourceFlag) {
  if (runId === void 0) throw new Error("usage: wt-observe await <runId> [--timeout-s N] [--poll-s N] [--source <label|dir>]");
  const { port, token } = await requireOwnedServer(ctx);
  const { prefix } = await resolveSourcePrefix(port, token, sourceFlag);
  const startedAt = Date.now();
  for (; ; ) {
    const live = await api(port, token, `${prefix}/api/runs/live`).then((r) => r.ok ? r.json() : []).catch(() => []);
    const entry = live.find((e) => e.runId === runId) ?? null;
    let recallStatus = null;
    let recall = null;
    if (entry === null || entry.finished) {
      recall = await fetchRecall(port, token, prefix, runId);
      recallStatus = extractAwaitOutcome(recall).status;
    }
    const verdict = classifyAwaitTick({
      live: entry === null ? null : { finished: entry.finished, status: entry.status },
      recallStatus,
      elapsedMs: Date.now() - startedAt,
      timeoutMs: timeoutS * 1e3,
      missingGraceMs: AWAIT_MISSING_GRACE_MS
    });
    if (verdict.kind === "pending") {
      await new Promise((r) => setTimeout(r, pollS * 1e3));
      continue;
    }
    if (verdict.kind === "done") {
      let outcome = extractAwaitOutcome(recall);
      const resultRuledOut = (s) => s !== null && s !== "completed" && s !== "unknown";
      for (let i = 0; i < AWAIT_SETTLE_TRIES && outcome.result === null && !resultRuledOut(outcome.status); i++) {
        await new Promise((r) => setTimeout(r, AWAIT_SETTLE_INTERVAL_MS));
        recall = await fetchRecall(port, token, prefix, runId);
        outcome = extractAwaitOutcome(recall);
      }
      const status = outcome.status ?? verdict.status;
      process.stdout.write(`${JSON.stringify({ runId, status, result: outcome.result })}
`);
      return awaitExitCode({ kind: "done", status });
    }
    process.stdout.write(`${JSON.stringify({ runId, error: verdict.kind })}
`);
    return awaitExitCode(verdict);
  }
}
async function cmdConfigShow() {
  const configRoot = observeConfigRoot(process.env, homedir2(), process.platform);
  const configPath = join5(configRoot, "config.json");
  const { sources, remotes } = readObserveConfig(configRoot);
  const discovered = [...new Set(discoverConfigDirCandidates(process.env, homedir2()).map(resolveDir))];
  process.stdout.write(`config file : ${configPath}
`);
  process.stdout.write(`configured  : ${sources.length > 0 ? sources.join(", ") : "(none \u2014 start falls through to auto-discovery)"}
`);
  process.stdout.write(`discovered  : ${discovered.length > 0 ? discovered.join(", ") : "(none found)"}
`);
  process.stdout.write(`remotes     : ${remotes.length > 0 ? remotes.map(describeRemote).join(", ") : "(none configured)"}
`);
  if (sources.length > 0) {
    process.stdout.write("note        : a non-empty configured list WINS over discovery outright for `start` \u2014 the discovered list above is informational only.\n");
  }
}
async function cmdConfigAddSource(dirRaw) {
  const dir = resolveDir(dirRaw);
  if (!existsSync2(dir)) throw new Error(`config add-source ${dirRaw}: directory does not exist (resolved to ${dir})`);
  const configRoot = observeConfigRoot(process.env, homedir2(), process.platform);
  const config = readObserveConfig(configRoot);
  const already = config.sources.some((s) => resolveDir(s) === dir);
  const next = already ? config.sources : [...config.sources, dir];
  writeObserveConfig(configRoot, { ...config, sources: next });
  process.stdout.write(`sources: ${next.join(", ")}
`);
}
async function cmdConfigRemoveSource(dirRaw) {
  const dir = resolveDir(dirRaw);
  const configRoot = observeConfigRoot(process.env, homedir2(), process.platform);
  const config = readObserveConfig(configRoot);
  const next = config.sources.filter((s) => resolveDir(s) !== dir);
  writeObserveConfig(configRoot, { ...config, sources: next });
  process.stdout.write(`sources: ${next.length > 0 ? next.join(", ") : "(none configured)"}
`);
}
function describeRemote(remote) {
  const label = remote.label !== void 0 ? ` (${remote.label})` : "";
  const cred = remote.token !== void 0 ? " [token]" : remote.tokenFile !== void 0 ? ` [token-file: ${remote.tokenFile}]` : "";
  return `${remote.url}${label}${cred}`;
}
async function cmdConfigAddRemote(remote) {
  const url = normalizeRemoteUrl(remote.url);
  if (url === null) throw new Error(`config add-remote ${remote.url}: not a usable http(s) URL`);
  const configRoot = observeConfigRoot(process.env, homedir2(), process.platform);
  const config = readObserveConfig(configRoot);
  if (remote.token !== void 0) {
    process.stderr.write(
      `[wt-observe] warning: --token exposes the remote credential in argv (ps / shell history on a shared host). Prefer --token-file pointing at the remote's server.json \u2014 see docs/public/observe-federation.md.
`
    );
  }
  const entry = { url };
  if (remote.token !== void 0) entry.token = remote.token;
  if (remote.tokenFile !== void 0) entry.tokenFile = remote.tokenFile;
  if (remote.label !== void 0) entry.label = remote.label;
  const wasNoRemotes = config.remotes.length === 0;
  const kept = config.remotes.filter((r) => normalizeRemoteUrl(r.url) !== url);
  const next = [...kept, entry];
  writeObserveConfig(configRoot, { ...config, remotes: next });
  process.stdout.write(`remotes: ${next.map(describeRemote).join(", ")}
`);
  if (wasNoRemotes) {
    process.stderr.write(
      `[wt-observe] note: with a remote configured the server runs in HUB mode \u2014 bare /api/* routes are now served under /s/<key>/api/*. wt-observe launch|await handle this; direct /api/* scripts must add the source prefix.
`
    );
  }
}
async function cmdConfigRemoveRemote(urlRaw) {
  const url = normalizeRemoteUrl(urlRaw);
  if (url === null) throw new Error(`config remove-remote ${urlRaw}: not a usable http(s) URL`);
  const configRoot = observeConfigRoot(process.env, homedir2(), process.platform);
  const config = readObserveConfig(configRoot);
  const next = config.remotes.filter((r) => normalizeRemoteUrl(r.url) !== url);
  writeObserveConfig(configRoot, { ...config, remotes: next });
  process.stdout.write(`remotes: ${next.length > 0 ? next.map(describeRemote).join(", ") : "(none configured)"}
`);
}
function flagValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : void 0;
}
function flagValues(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== void 0) out.push(argv[i + 1]);
  }
  return out;
}
function scanRunsForPrune(configDirs) {
  const subdirs = (p) => {
    try {
      return readdirSync3(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const filesIn = (p) => {
    try {
      return readdirSync3(p, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const RUNID_IN_SCRIPT = /-(wf_[A-Za-z0-9_-]+)\.js$/;
  const RUN_JSON = /^(wf_[A-Za-z0-9_-]+)\.json$/;
  const records = [];
  const seen = /* @__PURE__ */ new Set();
  for (const configDir of new Set(configDirs)) {
    const projectsDir = join5(configDir, "projects");
    const scriptByRun = /* @__PURE__ */ new Map();
    for (const slug of subdirs(projectsDir)) {
      for (const session of subdirs(join5(projectsDir, slug))) {
        const scriptsDir = join5(projectsDir, slug, session, "workflows", "scripts");
        for (const f of filesIn(scriptsDir)) {
          const m = RUNID_IN_SCRIPT.exec(f);
          if (m) scriptByRun.set(m[1], { name: runNameFromScript(f, m[1]), scriptPath: join5(scriptsDir, f) });
        }
      }
    }
    for (const slug of subdirs(projectsDir)) {
      for (const session of subdirs(join5(projectsDir, slug))) {
        const wfDir = join5(projectsDir, slug, session, "workflows");
        for (const f of filesIn(wfDir)) {
          const m = RUN_JSON.exec(f);
          if (!m) continue;
          const runId = m[1];
          const jsonPath = join5(wfDir, f);
          if (seen.has(jsonPath)) continue;
          seen.add(jsonPath);
          let mtimeMs;
          try {
            mtimeMs = statSync2(jsonPath).mtimeMs;
          } catch {
            continue;
          }
          const sc = scriptByRun.get(runId);
          records.push({
            runId,
            name: sc?.name ?? null,
            mtimeMs,
            jsonPath,
            scriptPath: sc?.scriptPath ?? null,
            sidecarDir: join5(projectsDir, slug, session, "subagents", "workflows", runId)
          });
        }
      }
    }
  }
  return records;
}
async function cmdPrune(argv) {
  const runId = flagValue(argv, "run");
  const explicitPrefixes = flagValues(argv, "name-prefix");
  const olderThanRaw = flagValue(argv, "older-than");
  const execute = argv.includes("--yes") || argv.includes("--force");
  let olderThanMs = null;
  if (olderThanRaw !== void 0) {
    olderThanMs = parseDurationMs(olderThanRaw);
    if (olderThanMs === null) {
      process.stderr.write(`prune: invalid --older-than '${olderThanRaw}' (use e.g. 45s, 30m, 2h, 7d)
`);
      return 2;
    }
  }
  const configDirs = [...new Set(discoverConfigDirCandidates(process.env, homedir2()).map(resolveDir))];
  const records = scanRunsForPrune(configDirs);
  const selected = selectRuns(records, {
    runId: runId ?? null,
    namePrefixes: explicitPrefixes.length > 0 ? explicitPrefixes : null,
    olderThanMs,
    nowMs: Date.now()
  });
  const scope = runId ? `run ${runId}` : `name-prefix [${(explicitPrefixes.length > 0 ? explicitPrefixes : DEFAULT_TEST_PREFIXES).join(", ")}]` + (olderThanMs !== null ? ` older than ${olderThanRaw}` : "");
  if (selected.length === 0) {
    process.stdout.write(`prune: no runs match (${scope}) across ${configDirs.length} config dir(s).
`);
    return 0;
  }
  const verb = execute ? "Deleting" : "Would delete (dry-run \u2014 pass --yes to apply)";
  process.stdout.write(`${verb} ${selected.length} run(s) \u2014 ${scope}:
`);
  for (const r of selected) {
    process.stdout.write(`  ${r.runId}  ${r.name ?? "(no name)"}
`);
    if (execute) for (const p of pathsToDelete(r)) rmSync2(p, { recursive: true, force: true });
  }
  if (!execute) process.stdout.write("(nothing deleted \u2014 re-run with --yes)\n");
  return 0;
}
async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] ?? "status";
  const ctx = makeCtx();
  try {
    if (cmd === "start") {
      const sourceDirs = resolveStartSources(flagValues(argv, "source"));
      const remotes = resolveStartRemotes();
      await cmdStart(ctx, sourceDirs, remotes, { watch: argv.includes("--watch"), enableLaunch: argv.includes("--enable-launch") });
    } else if (cmd === "stop") await cmdStop(ctx);
    else if (cmd === "status") await cmdStatus(ctx);
    else if (cmd === "prune") return await cmdPrune(argv);
    else if (cmd === "launch") await cmdLaunch(ctx, argv[1], flagValue(argv, "args"), flagValue(argv, "source"));
    else if (cmd === "await") {
      const timeoutS = Number(flagValue(argv, "timeout-s") ?? AWAIT_DEFAULT_TIMEOUT_S) || AWAIT_DEFAULT_TIMEOUT_S;
      const pollS = Number(flagValue(argv, "poll-s") ?? AWAIT_DEFAULT_POLL_S) || AWAIT_DEFAULT_POLL_S;
      return await cmdAwait(ctx, argv[1], timeoutS, pollS, flagValue(argv, "source"));
    } else if (cmd === "config") {
      const parsed = parseConfigAction(argv.slice(1));
      if (parsed.action === "invalid") {
        process.stderr.write(`${parsed.message}
`);
        return 2;
      }
      if (parsed.action === "show") await cmdConfigShow();
      else if (parsed.action === "add-source") await cmdConfigAddSource(parsed.dir);
      else if (parsed.action === "remove-source") await cmdConfigRemoveSource(parsed.dir);
      else if (parsed.action === "add-remote") await cmdConfigAddRemote(parsed);
      else await cmdConfigRemoveRemote(parsed.url);
    } else {
      process.stderr.write(
        "usage: wt-observe [start [--source <dir>]... [--watch] [--enable-launch]|stop|status|launch <workflow.js> [--args <json>] [--source <label|dir>]|await <runId> [--timeout-s N] [--poll-s N] [--source <label|dir>]|config [show|add-source <dir>|remove-source <dir>|add-remote <url> [--token <t>|--token-file <p>] [--label <l>]|remove-remote <url>]]\n"
      );
      return 2;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`wt-observe ${cmd}: ${err instanceof Error ? err.message : String(err)}
`);
    return 1;
  }
}
var argv1 = process.argv[1];
if (argv1 !== void 0) {
  let same = false;
  try {
    const { realpathSync: realpathSync3 } = await import("node:fs");
    same = import.meta.url === pathToFileURL(realpathSync3(argv1)).href;
  } catch {
    same = import.meta.url === pathToFileURL(argv1).href;
  }
  if (same) {
    process.exitCode = await main();
  }
}
export {
  main,
  scanRunsForPrune
};
