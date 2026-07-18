#!/usr/bin/env node

// packages/debugger/src/observe-cli.ts
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync4, readdirSync as readdirSync3, realpathSync as realpathSync2, renameSync as renameSync3, rmSync as rmSync2, statSync as statSync2, unlinkSync as unlinkSync3, writeFileSync as writeFileSync3, openSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { delimiter, dirname, join as join6, resolve as resolvePath } from "node:path";
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

// packages/debugger/src/validator-shared.ts
var FORBIDDEN_ENTRY_NAMES = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
function isRecord2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
var MCP_ANCHOR_KEYS = ["command", "url", "type"];
function validateMcpServersShape(v, path, errors) {
  if (!isRecord2(v)) {
    errors.push(`${path} must be an object map of server-name \u2192 server config`);
    return;
  }
  for (const name of Object.keys(v)) {
    if (FORBIDDEN_ENTRY_NAMES.has(name)) {
      errors.push(`${path}.${name} is a forbidden entry name (prototype-collision defence)`);
      continue;
    }
    const cfg = v[name];
    if (!isRecord2(cfg)) {
      errors.push(`${path}.${name} must be an object (server config)`);
      continue;
    }
    if (!MCP_ANCHOR_KEYS.some((k) => k in cfg)) {
      errors.push(`${path}.${name} lacks any of ${MCP_ANCHOR_KEYS.join("/")} \u2014 not a launchable server config`);
    }
    for (const k of MCP_ANCHOR_KEYS) {
      if (k in cfg && typeof cfg[k] !== "string") errors.push(`${path}.${name}.${k} must be a string`);
    }
  }
}

// packages/debugger/src/capabilities.ts
var SECTION_KEYS = /* @__PURE__ */ new Set(["mcpServers", "agents", "skills", "skillOverrides", "disableBundledSkills"]);
var SKILL_OVERRIDE_MODES = /* @__PURE__ */ new Set(["on", "name-only", "user-invocable-only", "off"]);
var AGENT_DEF_KEYS = /* @__PURE__ */ new Set([
  "description",
  "tools",
  "disallowedTools",
  "prompt",
  "model",
  "mcpServers",
  "criticalSystemReminder_EXPERIMENTAL",
  "skills",
  "initialPrompt",
  "maxTurns",
  "background",
  "memory",
  "effort",
  "permissionMode",
  "observer",
  "observerMessage"
]);
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function checkEntryNames(map, path, errors) {
  for (const name of Object.keys(map)) {
    if (FORBIDDEN_ENTRY_NAMES.has(name)) errors.push(`${path}.${name} is a forbidden entry name (prototype-collision defence)`);
  }
}
var MCP_ANCHOR_KEYS2 = ["command", "url", "type"];
function validateMcpServers(v, errors) {
  if (!isRecord2(v)) {
    errors.push("capabilities.mcpServers must be an object map of server-name \u2192 server config");
    return void 0;
  }
  checkEntryNames(v, "capabilities.mcpServers", errors);
  for (const [name, cfg] of Object.entries(v)) {
    if (!isRecord2(cfg)) {
      errors.push(`capabilities.mcpServers.${name} must be an object (server config)`);
      continue;
    }
    if (!MCP_ANCHOR_KEYS2.some((k) => k in cfg)) {
      errors.push(`capabilities.mcpServers.${name} lacks any of ${MCP_ANCHOR_KEYS2.join("/")} \u2014 not a launchable server config`);
    }
    for (const k of MCP_ANCHOR_KEYS2) {
      if (k in cfg && typeof cfg[k] !== "string") errors.push(`capabilities.mcpServers.${name}.${k} must be a string`);
    }
  }
  return v;
}
function validateAgents(v, errors) {
  if (!isRecord2(v)) {
    errors.push("capabilities.agents must be an object map of agent-name \u2192 agent definition");
    return void 0;
  }
  checkEntryNames(v, "capabilities.agents", errors);
  for (const [name, def] of Object.entries(v)) {
    if (FORBIDDEN_ENTRY_NAMES.has(name)) continue;
    if (!isRecord2(def)) {
      errors.push(`capabilities.agents.${name} must be an object (agent definition)`);
      continue;
    }
    for (const key of Object.keys(def)) {
      if (!AGENT_DEF_KEYS.has(key)) errors.push(`capabilities.agents.${name}.${key} is not a known AgentDefinition field (typo?)`);
    }
    if (typeof def["description"] !== "string") errors.push(`capabilities.agents.${name} needs a string description`);
    if (typeof def["prompt"] !== "string") errors.push(`capabilities.agents.${name} needs a string prompt`);
    if ("tools" in def && !isStringArray(def["tools"])) errors.push(`capabilities.agents.${name}.tools must be a string array`);
    else if ("tools" in def && isStringArray(def["tools"])) {
      for (const t of def["tools"]) {
        if (t.startsWith("$cap:")) errors.push(`capabilities.agents.${name}.tools contains an unresolved placeholder "${t}" \u2014 $cap:<need> tokens must be expanded by the launcher's resolver before reaching the server`);
      }
    }
    if ("disallowedTools" in def && !isStringArray(def["disallowedTools"])) errors.push(`capabilities.agents.${name}.disallowedTools must be a string array`);
    if ("skills" in def && !isStringArray(def["skills"])) errors.push(`capabilities.agents.${name}.skills must be a string array`);
    if ("model" in def && typeof def["model"] !== "string") errors.push(`capabilities.agents.${name}.model must be a string`);
    if ("effort" in def && typeof def["effort"] !== "string" && typeof def["effort"] !== "number") errors.push(`capabilities.agents.${name}.effort must be a string or number`);
    if ("maxTurns" in def && typeof def["maxTurns"] !== "number") errors.push(`capabilities.agents.${name}.maxTurns must be a number`);
    if ("background" in def && typeof def["background"] !== "boolean") errors.push(`capabilities.agents.${name}.background must be a boolean`);
    if ("mcpServers" in def && !Array.isArray(def["mcpServers"])) errors.push(`capabilities.agents.${name}.mcpServers must be an array (SDK AgentMcpServerSpec[])`);
    for (const strField of ["memory", "permissionMode", "initialPrompt", "criticalSystemReminder_EXPERIMENTAL", "observer", "observerMessage"]) {
      if (strField in def && typeof def[strField] !== "string") errors.push(`capabilities.agents.${name}.${strField} must be a string`);
    }
  }
  return v;
}
function validateSkillOverrides(v, errors) {
  if (!isRecord2(v)) {
    errors.push(`capabilities.skillOverrides must be an object map of skill-name \u2192 mode (${[...SKILL_OVERRIDE_MODES].join("|")})`);
    return void 0;
  }
  checkEntryNames(v, "capabilities.skillOverrides", errors);
  for (const [skill, mode] of Object.entries(v)) {
    if (FORBIDDEN_ENTRY_NAMES.has(skill)) continue;
    if (typeof mode !== "string" || !SKILL_OVERRIDE_MODES.has(mode)) {
      errors.push(`capabilities.skillOverrides.${skill} must be one of ${[...SKILL_OVERRIDE_MODES].join("|")} (got ${JSON.stringify(mode)})`);
    }
  }
  return v;
}
function extractCapabilities(args) {
  if (!isRecord2(args) || !("capabilities" in args)) return { spec: null, errors: [] };
  const raw = args["capabilities"];
  if (raw === null) return { spec: null, errors: [] };
  if (!isRecord2(raw)) return { spec: null, errors: ["capabilities must be an object ({ mcpServers?, agents?, skills?, skillOverrides?, disableBundledSkills? })"] };
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!SECTION_KEYS.has(key)) errors.push(`capabilities.${key} is not a known section (known: ${[...SECTION_KEYS].join(", ")})`);
  }
  const spec = {};
  if ("mcpServers" in raw) {
    const m = validateMcpServers(raw["mcpServers"], errors);
    if (m !== void 0) spec.mcpServers = m;
  }
  if ("agents" in raw) {
    const a = validateAgents(raw["agents"], errors);
    if (a !== void 0) spec.agents = a;
  }
  if ("skills" in raw) {
    if (!isStringArray(raw["skills"])) errors.push("capabilities.skills must be a string array (SDK skill enable-filter)");
    else spec.skills = raw["skills"];
  }
  if ("skillOverrides" in raw) {
    const so = validateSkillOverrides(raw["skillOverrides"], errors);
    if (so !== void 0) spec.skillOverrides = so;
  }
  if ("disableBundledSkills" in raw) {
    if (typeof raw["disableBundledSkills"] !== "boolean") errors.push("capabilities.disableBundledSkills must be a boolean");
    else spec.disableBundledSkills = raw["disableBundledSkills"];
  }
  return errors.length > 0 ? { spec: null, errors } : { spec, errors: [] };
}
function composeCapabilityOptions(spec) {
  const settings = {};
  if (spec.skillOverrides !== void 0) settings.skillOverrides = spec.skillOverrides;
  if (spec.disableBundledSkills !== void 0) settings.disableBundledSkills = spec.disableBundledSkills;
  return {
    ...spec.mcpServers !== void 0 ? { mcpServers: spec.mcpServers } : {},
    ...spec.agents !== void 0 ? { agents: spec.agents } : {},
    ...spec.skills !== void 0 ? { skills: spec.skills } : {},
    ...Object.keys(settings).length > 0 ? { settings } : {}
  };
}
function mergeSkillSettings(base, override) {
  const merged = {};
  const disable = override?.disableBundledSkills ?? base.disableBundledSkills;
  if (disable !== void 0) merged.disableBundledSkills = disable;
  const skillOverrides = { ...base.skillOverrides ?? {}, ...override?.skillOverrides ?? {} };
  if (Object.keys(skillOverrides).length > 0) merged.skillOverrides = skillOverrides;
  return merged;
}

// packages/debugger/src/capability-registry.ts
import { readFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join4 } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
var DEGRADATIONS = {
  "code-intelligence": { degradation: "degraded:grep-glob", tools: ["Grep", "Glob", "Read"] },
  "web-search": { degradation: "degraded:none", tools: [] },
  "context-offload": { degradation: "degraded:inline", tools: [] }
};
function degradationFor(need, webAvailable) {
  if (need === "docs-lookup") {
    return webAvailable ? { degradation: "degraded:web", tools: ["WebSearch", "WebFetch"] } : { degradation: "degraded:none", tools: [] };
  }
  return DEGRADATIONS[need] ?? { degradation: "degraded:none", tools: [] };
}
function resolveCapabilities(needs, registry, opts = {}) {
  const availability = opts.availability ?? {};
  const webAvailable = opts.webAvailable ?? true;
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const n of needs) {
    if (seen.has(n.need)) continue;
    seen.add(n.need);
    const providers = Object.hasOwn(registry.providers, n.need) ? registry.providers[n.need] ?? [] : [];
    const provider = providers.find((p) => availability[p.name] ?? true);
    if (provider) {
      out.push({
        need: n.need,
        provider: provider.name,
        mcpServers: provider.mcpServers ?? {},
        tools: provider.tools ?? [],
        ...provider.protocolHint !== void 0 ? { protocolHint: provider.protocolHint } : {}
      });
    } else {
      const d = degradationFor(n.need, webAvailable);
      out.push({ need: n.need, unresolved: true, degradation: d.degradation, tools: d.tools });
    }
  }
  return out;
}
var DEFAULT_PROBE_TIMEOUT_MS = 5e3;
function tokenizeCommand(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}
var defaultProbeSpawn = (argv, { timeoutMs }) => new Promise((resolve2) => {
  let settled = false;
  const finish = (o) => {
    if (settled) return;
    settled = true;
    resolve2(o);
  };
  const cmd = argv[0];
  if (cmd === void 0) {
    finish({ code: null, timedOut: false, error: "empty probe command" });
    return;
  }
  let child;
  try {
    child = nodeSpawn(cmd, argv.slice(1), { stdio: "ignore" });
  } catch (e) {
    finish({ code: null, timedOut: false, error: String(e) });
    return;
  }
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish({ code: null, timedOut: true });
  }, timeoutMs);
  child.on("error", (e) => {
    clearTimeout(timer);
    finish({ code: null, timedOut: false, error: String(e) });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    finish({ code, timedOut: false });
  });
});
async function probeProviders(registry, opts = {}) {
  const spawn2 = opts.spawn ?? defaultProbeSpawn;
  const seen = /* @__PURE__ */ new Set();
  const jobs = [];
  for (const providers of Object.values(registry.providers)) {
    for (const p of providers) {
      if (!p.probe || seen.has(p.name)) continue;
      seen.add(p.name);
      const timeoutMs = p.probe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
      const argv = tokenizeCommand(p.probe.command);
      const name = p.name;
      jobs.push(
        (async () => {
          if (argv.length === 0) return [name, false];
          try {
            const r = await spawn2(argv, { timeoutMs });
            return [name, !r.timedOut && r.error === void 0 && r.code === 0];
          } catch {
            return [name, false];
          }
        })()
      );
    }
  }
  const results = await Promise.all(jobs);
  const out = {};
  for (const [name, ok] of results) out[name] = ok;
  return out;
}
var PROVIDER_KEYS = /* @__PURE__ */ new Set(["name", "mcpServers", "tools", "protocolHint", "probe"]);
var PROBE_KEYS = /* @__PURE__ */ new Set(["command", "timeoutMs"]);
function isStringArray2(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function defaultRegistryPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== void 0 && xdg.length > 0 ? xdg : join4(homedir2(), ".config");
  return join4(base, "workflow-toolbox", "capability-registry.json");
}
function validateProbe(v, path, errors) {
  if (!isRecord2(v)) {
    errors.push(`${path} must be an object { command, timeoutMs? }`);
    return;
  }
  for (const k of Object.keys(v)) {
    if (!PROBE_KEYS.has(k)) errors.push(`${path}.${k} is not a known probe field (typo?)`);
  }
  if (typeof v["command"] !== "string" || v["command"].length === 0) errors.push(`${path}.command must be a non-empty string`);
  if ("timeoutMs" in v && typeof v["timeoutMs"] !== "number") errors.push(`${path}.timeoutMs must be a number`);
}
function validateProvider(v, path, errors) {
  if (!isRecord2(v)) {
    errors.push(`${path} must be an object (provider)`);
    return;
  }
  for (const k of Object.keys(v)) {
    if (!PROVIDER_KEYS.has(k)) errors.push(`${path}.${k} is not a known provider field (typo?)`);
  }
  if (typeof v["name"] !== "string" || v["name"].length === 0) errors.push(`${path}.name must be a non-empty string`);
  if ("tools" in v && !isStringArray2(v["tools"])) errors.push(`${path}.tools must be a string array`);
  if ("protocolHint" in v && typeof v["protocolHint"] !== "string") errors.push(`${path}.protocolHint must be a string`);
  if ("mcpServers" in v) validateMcpServersShape(v["mcpServers"], `${path}.mcpServers`, errors);
  if ("probe" in v) validateProbe(v["probe"], `${path}.probe`, errors);
}
function validateRegistry(v, errors) {
  if (!isRecord2(v)) {
    errors.push("capability-registry must be a JSON object { version, providers }");
    return { version: 1, providers: {} };
  }
  if (v["version"] !== 1) errors.push("capability-registry.version must be 1");
  const providers = {};
  const raw = v["providers"];
  if (!isRecord2(raw)) {
    errors.push("capability-registry.providers must be an object map of need \u2192 provider[]");
  } else {
    for (const need of Object.keys(raw)) {
      if (FORBIDDEN_ENTRY_NAMES.has(need)) {
        errors.push(`capability-registry.providers.${need} is a forbidden entry name (prototype-collision defence)`);
        continue;
      }
      const arr = raw[need];
      if (!Array.isArray(arr)) {
        errors.push(`capability-registry.providers.${need} must be an array of providers`);
        continue;
      }
      arr.forEach((p, i) => validateProvider(p, `capability-registry.providers.${need}[${i}]`, errors));
      providers[need] = arr;
    }
  }
  return { version: 1, providers };
}
function loadCapabilityRegistry(opts = {}) {
  const path = opts.path ?? process.env.WT_CAPABILITY_REGISTRY ?? defaultRegistryPath();
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { registry: { version: 1, providers: {} }, errors: [] };
    return { registry: { version: 1, providers: {} }, errors: [`capability-registry: cannot read ${path}: ${String(e)}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { registry: { version: 1, providers: {} }, errors: [`capability-registry: invalid JSON at ${path}: ${e.message}`] };
  }
  const errors = [];
  const registry = validateRegistry(parsed, errors);
  return errors.length > 0 ? { registry: { version: 1, providers: {} }, errors } : { registry, errors: [] };
}
var CAP_PREFIX = "$cap:";
function paramsNote(params) {
  if (!params || Object.keys(params).length === 0) return "";
  return ` [${Object.entries(params).map(([k, val]) => `${k}=${val}`).join(", ")}]`;
}
function buildResolutionNote(needs, resMap) {
  const byNeed = /* @__PURE__ */ new Map();
  for (const n of needs) if (!byNeed.has(n.need)) byNeed.set(n.need, n);
  if (byNeed.size === 0) return "";
  const lines = [];
  for (const n of byNeed.values()) {
    const res = resMap.get(n.need);
    const p = paramsNote(n.params);
    if (!res) lines.push(`- ${n.need}${p} \u2192 (unresolved)`);
    else if ("unresolved" in res) lines.push(`- ${n.need}${p} \u2192 DEGRADED: ${res.degradation}`);
    else lines.push(`- ${n.need}${p} \u2192 ${res.provider}${res.protocolHint !== void 0 ? ` \u2014 ${res.protocolHint}` : ""}`);
  }
  return `

## Capability resolution
${lines.join("\n")}
Use the resolved tools above to RETRIEVE; prefer them over generic text search.`;
}
function validateSidecarShape(sidecar) {
  const errors = [];
  if (!isRecord2(sidecar)) return ["sidecar must be an object { version, roles, agents }"];
  if (!isRecord2(sidecar.roles)) {
    errors.push("sidecar.roles must be an object map of role-name \u2192 { agent, needs }");
  } else {
    for (const [roleName, role] of Object.entries(sidecar.roles)) {
      if (!isRecord2(role)) {
        errors.push(`sidecar.roles.${roleName} must be an object { agent, needs }`);
        continue;
      }
      if (typeof role.agent !== "string" || role.agent.length === 0) errors.push(`sidecar.roles.${roleName}.agent must be a non-empty string`);
      if (!Array.isArray(role.needs)) {
        errors.push(`sidecar.roles.${roleName}.needs must be an array of { need, optional?, params? }`);
      } else {
        role.needs.forEach((n, i) => {
          if (!isRecord2(n)) errors.push(`sidecar.roles.${roleName}.needs[${i}] must be an object`);
          else if (typeof n["need"] !== "string" || n["need"].length === 0) errors.push(`sidecar.roles.${roleName}.needs[${i}].need must be a non-empty string`);
        });
      }
    }
  }
  if (!isRecord2(sidecar.agents)) {
    errors.push("sidecar.agents must be an object map of agent-name \u2192 { description, prompt, tools? }");
  } else {
    for (const [agentName, def] of Object.entries(sidecar.agents)) {
      if (!isRecord2(def)) {
        errors.push(`sidecar.agents.${agentName} must be an object (agent definition)`);
        continue;
      }
      if (typeof def["description"] !== "string") errors.push(`sidecar.agents.${agentName}.description must be a string`);
      if (typeof def["prompt"] !== "string") errors.push(`sidecar.agents.${agentName}.prompt must be a string`);
      if ("tools" in def && !isStringArray2(def["tools"])) errors.push(`sidecar.agents.${agentName}.tools must be a string array`);
    }
  }
  return errors;
}
function sidecarToCapabilitiesSpec(sidecar, resolutions) {
  const structuralErrors = validateSidecarShape(sidecar);
  if (structuralErrors.length > 0) return { spec: null, report: resolutions, errors: structuralErrors };
  const errors = [];
  const resMap = /* @__PURE__ */ new Map();
  for (const r of resolutions) resMap.set(r.need, r);
  const agentNeeds = /* @__PURE__ */ new Map();
  for (const [roleName, role] of Object.entries(sidecar.roles)) {
    if (!Object.hasOwn(sidecar.agents, role.agent)) {
      errors.push(`role '${roleName}' references unknown agent '${role.agent}'`);
    } else {
      const acc = agentNeeds.get(role.agent) ?? [];
      acc.push(...role.needs);
      agentNeeds.set(role.agent, acc);
    }
    for (const need of role.needs) {
      const res = resMap.get(need.need);
      if (!res) {
        errors.push(`role '${roleName}' need '${need.need}' has no resolution (resolve it before projecting)`);
      } else if ("unresolved" in res && res.degradation === "degraded:none" && need.optional !== true) {
        errors.push(`required capability '${need.need}' for role '${roleName}' is unresolvable (no provider and no fallback) \u2014 declare optional:true to run degraded`);
      }
    }
  }
  const mountedMcp = {};
  const outAgents = {};
  for (const [agentName, def] of Object.entries(sidecar.agents)) {
    if (FORBIDDEN_ENTRY_NAMES.has(agentName)) {
      errors.push(`agents.${agentName} is a forbidden entry name (prototype-collision defence)`);
      continue;
    }
    const smuggledMcp = def.mcpServers;
    if (smuggledMcp !== void 0) {
      errors.push(`agent '${agentName}' must not declare mcpServers \u2014 the machine registry is the only provider source (a sidecar is machine-agnostic)`);
    }
    if (def.tools === void 0) {
      errors.push(`agent '${agentName}' declares no tools allowlist \u2014 a sidecar agent must declare an EXACT allowlist (an omitted allowlist inherits ALL ambient tools; design \xA79.2/\xA79.3 'rien d'implicite')`);
    }
    const declared = new Set((agentNeeds.get(agentName) ?? []).map((n) => n.need));
    const expanded = [];
    for (const tool of def.tools ?? []) {
      if (tool.startsWith(CAP_PREFIX)) {
        const need = tool.slice(CAP_PREFIX.length);
        if (!declared.has(need)) {
          errors.push(`agent '${agentName}' uses '${tool}' but need '${need}' is not declared in its role needs (typo?)`);
          continue;
        }
        const res = resMap.get(need);
        if (!res) {
          errors.push(`agent '${agentName}' '${tool}': no resolution for need '${need}'`);
          continue;
        }
        for (const t of res.tools) expanded.push(t);
        if (!("unresolved" in res)) {
          for (const [srv, cfg] of Object.entries(res.mcpServers)) {
            if (FORBIDDEN_ENTRY_NAMES.has(srv)) {
              errors.push(`provider mcpServers key '${srv}' is a forbidden entry name (prototype-collision defence)`);
              continue;
            }
            mountedMcp[srv] = cfg;
          }
        }
      } else if (tool.startsWith("mcp__")) {
        errors.push(`agent '${agentName}' tool '${tool}' is a concrete MCP tool; a sidecar may only use ${CAP_PREFIX}<need> and non-MCP builtin tools (the machine registry is the trust root)`);
      } else {
        expanded.push(tool);
      }
    }
    const outDef = { ...def, prompt: def.prompt + buildResolutionNote(agentNeeds.get(agentName) ?? [], resMap), tools: [...new Set(expanded)] };
    if ("mcpServers" in outDef) delete outDef.mcpServers;
    outAgents[agentName] = outDef;
  }
  const built = {};
  if (Object.keys(mountedMcp).length > 0) built.mcpServers = mountedMcp;
  if (Object.keys(outAgents).length > 0) built.agents = outAgents;
  const deduped = [...new Set(errors)];
  return { spec: deduped.length > 0 ? null : built, report: resolutions, errors: deduped };
}

// packages/debugger/src/launch-capabilities.ts
var CWD_TOKEN = "$CWD";
function sidecarPathFor(workflowPath) {
  const base = workflowPath.endsWith(".js") ? workflowPath.slice(0, -".js".length) : workflowPath;
  return `${base}.capabilities.json`;
}
function substituteCwd(value, cwd) {
  if (typeof value === "string") return value.split(CWD_TOKEN).join(cwd);
  if (Array.isArray(value)) return value.map((v) => substituteCwd(v, cwd));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteCwd(v, cwd);
    return out;
  }
  return value;
}
function containsCwdToken(value) {
  if (typeof value === "string") return value.includes(CWD_TOKEN);
  if (Array.isArray(value)) return value.some(containsCwdToken);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsCwdToken);
  return false;
}
function redactResolutionsForReport(resolutions) {
  return resolutions.map(
    (r) => "unresolved" in r ? r : { need: r.need, provider: r.provider, servers: Object.keys(r.mcpServers), tools: r.tools, ...r.protocolHint !== void 0 ? { protocolHint: r.protocolHint } : {} }
  );
}
function collectNeeds(sidecar) {
  const needs = [];
  const roles = isRecord2(sidecar) ? sidecar.roles : void 0;
  if (!isRecord2(roles)) return needs;
  for (const role of Object.values(roles)) {
    if (isRecord2(role) && Array.isArray(role.needs)) {
      for (const n of role.needs) if (isRecord2(n) && typeof n.need === "string") needs.push(n);
    }
  }
  return needs;
}
function skillLayer(x) {
  const out = {};
  if (x?.disableBundledSkills !== void 0) out.disableBundledSkills = x.disableBundledSkills;
  if (x?.skillOverrides !== void 0) out.skillOverrides = x.skillOverrides;
  return out;
}
function mergeCapabilitiesSpecs(sidecarSpec, sidecarSkill, caller) {
  const merged = {};
  const mcpServers = { ...sidecarSpec.mcpServers ?? {}, ...caller?.mcpServers ?? {} };
  if (Object.keys(mcpServers).length > 0) merged.mcpServers = mcpServers;
  const agents = { ...sidecarSpec.agents ?? {}, ...caller?.agents ?? {} };
  if (Object.keys(agents).length > 0) merged.agents = agents;
  if (caller?.skills !== void 0) merged.skills = caller.skills;
  else if (sidecarSpec.skills !== void 0) merged.skills = sidecarSpec.skills;
  const skill = mergeSkillSettings(sidecarSkill, skillLayer(caller));
  if (skill.disableBundledSkills !== void 0) merged.disableBundledSkills = skill.disableBundledSkills;
  if (skill.skillOverrides !== void 0) merged.skillOverrides = skill.skillOverrides;
  return merged;
}
function observerDefinitionFileWarnings(observers, registryPresent) {
  if (!registryPresent) return [];
  const out = [];
  for (const e of observers) {
    if (isRecord2(e) && typeof e["definitionFile"] === "string") {
      out.push(
        `observer requires: '${e["definitionFile"]}' is a definitionFile \u2014 its abstract requires are NOT resolved launcher-side (only inline observer definitions are; a definitionFile's requires are resolved by the server). An unresolved required need becomes a server-side not-attach, never a launch failure.`
      );
    }
  }
  return out;
}
function foldCapabilitiesIntoArgs(args, capabilities, report, script) {
  if (args !== void 0 && !isRecord2(args)) {
    throw new Error(`workflow "${script}" has a capability sidecar but --args is not a JSON object \u2014 capabilities require object args`);
  }
  return { ...args ?? {}, capabilities, capabilitiesReport: report };
}
function resolveObserverRequires(requires, registry, availability, webAvailable, requesterCwd) {
  const resolved = resolveCapabilities(requires, registry, { availability, webAvailable });
  return resolved.map((r) => "unresolved" in r ? r : { ...r, mcpServers: substituteCwd(r.mcpServers, requesterCwd) });
}
function composeLaunchCapabilities(input) {
  const { sidecar, registry, availability, webAvailable, requesterCwd, callerCapabilities } = input;
  const errors = [];
  const needs = collectNeeds(sidecar);
  const resolved = resolveCapabilities(needs, registry, { availability, webAvailable });
  const substituted = resolved.map((r) => {
    if ("unresolved" in r) return r;
    if (requesterCwd.length === 0 && containsCwdToken(r.mcpServers)) {
      errors.push(`capability '${r.need}' provider '${r.provider}' uses ${CWD_TOKEN} but the requester cwd is unresolvable \u2014 launch from a resolvable directory`);
      return r;
    }
    return { ...r, mcpServers: substituteCwd(r.mcpServers, requesterCwd) };
  });
  const projected = sidecarToCapabilitiesSpec(sidecar, substituted);
  errors.push(...projected.errors);
  let capabilities = null;
  if (projected.spec !== null && errors.length === 0) {
    capabilities = mergeCapabilitiesSpecs(projected.spec, skillLayer(sidecar), callerCapabilities);
  }
  const deduped = [...new Set(errors)];
  return { capabilities: deduped.length > 0 ? null : capabilities, report: redactResolutionsForReport(projected.report), errors: deduped };
}

// packages/debugger/src/observer-def.ts
var OBSERVER_EMITTABLE_TYPES = ["observer.hint"];
var NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
var SELECTOR_ITEM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
var NEED_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
var CADENCE_FLOOR_MS = 6e4;
var MAX_OBSERVERS = 16;
var MAX_SELECTOR_ITEMS = 16;
var MAX_REQUIRES = 16;
var MAX_PARAMS = 16;
var DEFINITION_KEYS = /* @__PURE__ */ new Set(["schemaVersion", "name", "description", "watch", "cadenceMs", "brain", "emits", "actions", "requires"]);
var WATCH_KEYS = /* @__PURE__ */ new Set(["roles", "phases"]);
var BRAIN_KEYS = /* @__PURE__ */ new Set(["mandate", "model", "timeoutMs"]);
var NEED_KEYS = /* @__PURE__ */ new Set(["need", "optional", "params"]);
var ACTION_VALUES = /* @__PURE__ */ new Set(["summary", "nudge", "wt-comm"]);
function checkUnknownKeys(obj, known, path, errors) {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_ENTRY_NAMES.has(key)) {
      errors.push(`${path}.${key} is a forbidden key name (prototype-collision defence)`);
    } else if (!known.has(key)) {
      errors.push(`${path}.${key} is not a known field (typo?)`);
    }
  }
}
function validateBoundedString(v, path, min, max, errors) {
  if (typeof v !== "string" || v.length < min || v.length > max) {
    errors.push(`${path} must be a string of ${min}-${max} chars`);
  }
}
function validateSelectorArray(v, path, errors) {
  if (!Array.isArray(v)) {
    errors.push(`${path} must be a string array`);
    return;
  }
  if (v.length === 0 || v.length > MAX_SELECTOR_ITEMS) {
    errors.push(`${path} must carry 1-${MAX_SELECTOR_ITEMS} items`);
    return;
  }
  for (const item of v) {
    if (typeof item !== "string" || !SELECTOR_ITEM_PATTERN.test(item)) {
      errors.push(`${path} items must match ${SELECTOR_ITEM_PATTERN.source}`);
      return;
    }
  }
}
function validateWatch(v, path, errors) {
  if (!isRecord2(v)) {
    errors.push(`${path} must be an object ({ roles?, phases? })`);
    return;
  }
  if ("run" in v) errors.push(`${path}.run is not supported: whole-run content observation does not exist (role/phase selectors only)`);
  if ("transcriptFile" in v) errors.push(`${path}.transcriptFile is a machine path \u2014 forbidden in a workflow-owned definition (operator REST attach covers that case)`);
  const remaining = Object.fromEntries(Object.entries(v).filter(([k]) => k !== "run" && k !== "transcriptFile"));
  checkUnknownKeys(remaining, WATCH_KEYS, path, errors);
  const hasRoles = "roles" in v;
  const hasPhases = "phases" in v;
  if (!hasRoles && !hasPhases) {
    errors.push(`${path} needs at least one selector (roles and/or phases)`);
    return;
  }
  if (hasRoles) validateSelectorArray(v["roles"], `${path}.roles`, errors);
  if (hasPhases) validateSelectorArray(v["phases"], `${path}.phases`, errors);
}
function validateBrain(v, path, errors) {
  if (!isRecord2(v)) {
    errors.push(`${path} must be an object ({ mandate, model?, timeoutMs? })`);
    return;
  }
  checkUnknownKeys(v, BRAIN_KEYS, path, errors);
  validateBoundedString(v["mandate"], `${path}.mandate`, 20, 4e3, errors);
  if ("model" in v && typeof v["model"] !== "string") errors.push(`${path}.model must be a string`);
  if ("timeoutMs" in v) {
    const t = v["timeoutMs"];
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1) errors.push(`${path}.timeoutMs must be a positive integer (milliseconds)`);
  }
}
function validateEmits(v, path, errors) {
  if (!Array.isArray(v)) {
    errors.push(`${path} must be a string array of wt-comm message types`);
    return;
  }
  const seen = /* @__PURE__ */ new Set();
  for (const item of v) {
    if (typeof item !== "string" || !OBSERVER_EMITTABLE_TYPES.includes(item)) {
      errors.push(`${path} carries ${JSON.stringify(item)} \u2014 observers may emit only: ${OBSERVER_EMITTABLE_TYPES.join(", ")}`);
      continue;
    }
    if (seen.has(item)) errors.push(`${path} lists ${item} more than once`);
    seen.add(item);
  }
}
function validateActions(v, path, errors) {
  if (!Array.isArray(v)) {
    errors.push(`${path} must be an array of 'summary' | 'nudge' | 'wt-comm'`);
    return;
  }
  const seen = /* @__PURE__ */ new Set();
  for (const item of v) {
    if (item === "pause") {
      errors.push(`${path}: 'pause' is reserved until the pause primitive ships \u2014 not accepted yet`);
      continue;
    }
    if (typeof item !== "string" || !ACTION_VALUES.has(item)) {
      errors.push(`${path} carries ${JSON.stringify(item)} \u2014 known actions: ${[...ACTION_VALUES].join(", ")}`);
      continue;
    }
    if (seen.has(item)) errors.push(`${path} lists ${item} more than once`);
    seen.add(item);
  }
}
function validateRequires(v, path, errors) {
  if (!Array.isArray(v)) {
    errors.push(`${path} must be an array of capability needs ({ need, optional?, params? })`);
    return;
  }
  if (v.length > MAX_REQUIRES) {
    errors.push(`${path} must carry at most ${MAX_REQUIRES} needs`);
    return;
  }
  v.forEach((item, i) => {
    const itemPath = `${path}[${i}]`;
    if (!isRecord2(item)) {
      errors.push(`${itemPath} must be an object ({ need, optional?, params? })`);
      return;
    }
    checkUnknownKeys(item, NEED_KEYS, itemPath, errors);
    if (typeof item["need"] !== "string" || !NEED_PATTERN.test(item["need"])) {
      errors.push(`${itemPath}.need must match ${NEED_PATTERN.source} (an abstract capability name, e.g. docs-lookup)`);
    }
    if ("optional" in item && typeof item["optional"] !== "boolean") errors.push(`${itemPath}.optional must be a boolean`);
    if ("params" in item) {
      const params = item["params"];
      if (!isRecord2(params)) {
        errors.push(`${itemPath}.params must be an object map of string \u2192 string (abstract refinement only)`);
        return;
      }
      const keys = Object.keys(params);
      if (keys.length > MAX_PARAMS) errors.push(`${itemPath}.params must carry at most ${MAX_PARAMS} entries`);
      for (const key of keys) {
        if (FORBIDDEN_ENTRY_NAMES.has(key)) {
          errors.push(`${itemPath}.params.${key} is a forbidden key name (prototype-collision defence)`);
          continue;
        }
        if (typeof params[key] !== "string") errors.push(`${itemPath}.params.${key} must be a string`);
      }
    }
  });
}
function validateObserverDefinition(v, path, errors) {
  if (!isRecord2(v)) {
    errors.push(`${path} must be an object (an ObserverDefinition)`);
    return;
  }
  checkUnknownKeys(v, DEFINITION_KEYS, path, errors);
  if (v["schemaVersion"] !== 1) errors.push(`${path}.schemaVersion must be the integer 1`);
  if (typeof v["name"] !== "string" || !NAME_PATTERN.test(v["name"])) {
    errors.push(`${path}.name must match ${NAME_PATTERN.source}`);
  }
  validateBoundedString(v["description"], `${path}.description`, 1, 500, errors);
  validateWatch(v["watch"], `${path}.watch`, errors);
  if ("cadenceMs" in v) {
    const c = v["cadenceMs"];
    if (typeof c !== "number" || !Number.isInteger(c) || c < CADENCE_FLOOR_MS) {
      errors.push(`${path}.cadenceMs must be an integer >= ${CADENCE_FLOOR_MS} (the registration floor)`);
    }
  }
  validateBrain(v["brain"], `${path}.brain`, errors);
  if ("emits" in v) validateEmits(v["emits"], `${path}.emits`, errors);
  if ("actions" in v) validateActions(v["actions"], `${path}.actions`, errors);
  if ("requires" in v) validateRequires(v["requires"], `${path}.requires`, errors);
  const emits = Array.isArray(v["emits"]) ? v["emits"] : [];
  const actions = Array.isArray(v["actions"]) ? v["actions"] : [];
  const wantsComm = actions.includes("wt-comm");
  if (wantsComm && emits.length === 0) errors.push(`${path}: action 'wt-comm' requires a non-empty emits allowlist`);
  if (!wantsComm && emits.length > 0) errors.push(`${path}: emits is declared but actions lacks 'wt-comm' \u2014 the emitted types could never be delivered`);
}
function validateDefinitionFile(v, path, errors) {
  if (typeof v !== "string" || v.length === 0 || v.length > 512) {
    errors.push(`${path} must be a non-empty string path`);
    return;
  }
  if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) {
    errors.push(`${path} must be RELATIVE to the registered workflows dir \u2014 never an absolute path`);
  }
  if (v.split(/[\\/]/).includes("..")) {
    errors.push(`${path} must not traverse upward ('..')`);
  }
  if (!v.endsWith(".observer.json")) {
    errors.push(`${path} must reference a composer observer artifact ('<name>.observer.json')`);
  }
}
var RESOLVED_RESOLUTION_KEYS = /* @__PURE__ */ new Set(["need", "provider", "mcpServers", "tools", "protocolHint"]);
var UNRESOLVED_RESOLUTION_KEYS = /* @__PURE__ */ new Set(["need", "unresolved", "degradation", "tools"]);
var MAX_RESOLUTION = 32;
function isStringArray3(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function validateResolutionField(v, path, errors) {
  if (!Array.isArray(v)) {
    errors.push(`${path} must be an array of NeedResolution ({ need, provider, mcpServers, tools, protocolHint? } | { need, unresolved, degradation, tools })`);
    return;
  }
  if (v.length > MAX_RESOLUTION) {
    errors.push(`${path} must carry at most ${MAX_RESOLUTION} resolutions`);
    return;
  }
  v.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!isRecord2(item)) {
      errors.push(`${p} must be an object (NeedResolution)`);
      return;
    }
    if (typeof item["need"] !== "string" || item["need"].length === 0) errors.push(`${p}.need must be a non-empty string`);
    if (!isStringArray3(item["tools"])) errors.push(`${p}.tools must be a string array`);
    if (item["unresolved"] === true) {
      checkUnknownKeys(item, UNRESOLVED_RESOLUTION_KEYS, p, errors);
      if (typeof item["degradation"] !== "string" || item["degradation"].length === 0) errors.push(`${p}.degradation must be a non-empty string (an unresolved resolution names its degradation)`);
    } else if ("provider" in item) {
      checkUnknownKeys(item, RESOLVED_RESOLUTION_KEYS, p, errors);
      if (typeof item["provider"] !== "string" || item["provider"].length === 0) errors.push(`${p}.provider must be a non-empty string`);
      if (!isRecord2(item["mcpServers"])) errors.push(`${p}.mcpServers must be an object map of server-name \u2192 config`);
      if ("protocolHint" in item && typeof item["protocolHint"] !== "string") errors.push(`${p}.protocolHint must be a string`);
    } else {
      errors.push(`${p} must be a RESOLVED resolution (with 'provider') or an UNRESOLVED one ('unresolved: true') \u2014 got neither`);
    }
  });
}
function extractObservers(args) {
  if (!isRecord2(args) || !("observers" in args)) return { entries: null, errors: [] };
  const raw = args["observers"];
  if (raw === null) return { entries: null, errors: [] };
  if (!Array.isArray(raw)) {
    return { entries: null, errors: ["observers must be an array of { definition } | { definitionFile } entries"] };
  }
  const errors = [];
  if (raw.length > MAX_OBSERVERS) errors.push(`observers must carry at most ${MAX_OBSERVERS} entries`);
  const seenNames = /* @__PURE__ */ new Set();
  raw.forEach((entry, i) => {
    const path = `observers[${i}]`;
    if (!isRecord2(entry)) {
      errors.push(`${path} must be an object ({ definition } or { definitionFile })`);
      return;
    }
    const hasDefinition = "definition" in entry;
    const hasFile = "definitionFile" in entry;
    for (const key of Object.keys(entry)) {
      if (key !== "definition" && key !== "definitionFile" && key !== "resolution") errors.push(`${path}.${key} is not a known field (typo?)`);
    }
    if ("resolution" in entry) validateResolutionField(entry["resolution"], `${path}.resolution`, errors);
    if (hasDefinition === hasFile) {
      errors.push(`${path} must carry exactly ONE of definition | definitionFile`);
      return;
    }
    if (hasFile) {
      validateDefinitionFile(entry["definitionFile"], `${path}.definitionFile`, errors);
      return;
    }
    validateObserverDefinition(entry["definition"], `${path}.definition`, errors);
    const def = entry["definition"];
    if (isRecord2(def) && typeof def["name"] === "string") {
      if (seenNames.has(def["name"])) errors.push(`${path}.definition.name ${JSON.stringify(def["name"])} is declared twice \u2014 observer names must be unique per launch`);
      seenNames.add(def["name"]);
    }
  });
  return errors.length > 0 ? { entries: null, errors } : { entries: raw, errors: [] };
}

// packages/debugger/src/launch-body.ts
function buildLaunchBody(script, args, requesterCwd) {
  return {
    script,
    ...args !== void 0 ? { args } : {},
    ...requesterCwd.trim().length > 0 ? { requesterCwd } : {}
  };
}
function safeRequesterCwd(cwdFn) {
  try {
    return { cwd: cwdFn(), note: null };
  } catch {
    return {
      cwd: "",
      note: "requesterCwd unavailable (working directory unresolvable) \u2014 the run will appear under the Delegated bucket"
    };
  }
}

// packages/debugger/src/spawn-ready.ts
var BANNER_RE = /app \+ run discovery on http:\/\/127\.0\.0\.1:(\d+)/g;
function parseAnnouncedPort(logSlice) {
  let last = null;
  for (const m of logSlice.matchAll(BANNER_RE)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && n <= 65535) last = n;
  }
  return last;
}
var POLL_INTERVAL_MS = 500;
async function awaitSpawnedServerReady(deps) {
  const deadline = deps.now() + deps.timeoutMs;
  for (; ; ) {
    const st = deps.spawnState();
    if (st.error !== null) {
      throw new Error(`failed to spawn the server: ${st.error.message}`);
    }
    if (st.exited !== null) {
      const e = st.exited;
      throw new Error(
        `server exited immediately (code ${e.code ?? "null"}${e.signal ? `, signal ${e.signal}` : ""}).
${deps.logTail()}`
      );
    }
    const port = deps.requestedPort !== 0 ? deps.requestedPort : parseAnnouncedPort(deps.readLogSlice());
    if (port !== null) {
      const h = await deps.probe(port);
      if (deps.isReady(h)) return h;
    }
    if (deps.now() > deadline) {
      deps.kill();
      const where = deps.requestedPort !== 0 ? `:${deps.requestedPort}` : port !== null ? `:${port} (OS-assigned)` : "its OS-assigned port (never announced in the log)";
      throw new Error(
        `server did not become healthy on ${where} within ${deps.timeoutMs} ms \u2014 SIGTERM sent to the child (best-effort reap).
${deps.logTail()}`
      );
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

// packages/debugger/src/observe-identity.ts
import { execFileSync } from "node:child_process";
import { readFileSync as readFileSync2 } from "node:fs";
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
    return readFileSync2("/proc/sys/kernel/random/boot_id", "utf8").trim();
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
    const stat = readFileSync2(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(rest[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function pidIdentityMatches(pf) {
  if (pf.bootId === null || pf.procStartTicks === null) return false;
  return readBootId() === pf.bootId && readProcStartStamp(pf.pid) === pf.procStartTicks;
}
function pidState(pf) {
  const alive = pf !== null && pidAlive(pf.pid);
  return { alive, idMatch: pf !== null && alive && pidIdentityMatches(pf) };
}

// packages/debugger/src/observe-config.ts
import { mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync as readFileSync3, renameSync as renameSync2, statSync, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join5 } from "node:path";
var CONFIG_FILENAME = "config.json";
function readObserveConfig(configRoot) {
  let raw;
  try {
    raw = JSON.parse(readFileSync3(join5(configRoot, CONFIG_FILENAME), "utf8"));
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
  const path = join5(configRoot, CONFIG_FILENAME);
  const tmpPath = join5(configRoot, `.${CONFIG_FILENAME}.tmp-${process.pid}-${Date.now()}`);
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
    return statSync(join5(candidate, "projects")).isDirectory();
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
    for (const name of siblings) candidates.push(join5(home, name));
  } catch {
    candidates.push(join5(home, ".claude"));
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
  if (typeof recall !== "object" || recall === null) return { status: null, result: null, error: null };
  const r = recall;
  const status = typeof r["status"] === "string" ? r["status"] : null;
  const io = r["io"];
  const result = typeof io === "object" && io !== null ? io["result"] ?? null : null;
  const error = typeof r["error"] === "string" ? r["error"] : null;
  return { status, result, error };
}
var AWAIT_ERROR_MAX_CHARS = 2e3;
function truncateAwaitError(message, max = AWAIT_ERROR_MAX_CHARS) {
  return message.length <= max ? message : `${message.slice(0, max)}\u2026 [truncated ${message.length - max} chars \u2014 full error in the run record]`;
}
function awaitExitCode(verdict) {
  if (verdict.kind === "timeout") return 3;
  if (verdict.kind === "missing") return 4;
  return verdict.status === "completed" ? 0 : 2;
}
var AWAIT_SOURCE_UNRESOLVED_EXIT_CODE = 5;

// packages/debugger/src/observe-resume.ts
var RECOVER_REFUSED_EXIT_CODE = 2;
var RECOVER_NOT_FOUND_EXIT_CODE = 4;
function recoverExitCodeFor(status, ok, code) {
  if (ok) return 0;
  if (status === 404 && code === "not-found") return RECOVER_NOT_FOUND_EXIT_CODE;
  return RECOVER_REFUSED_EXIT_CODE;
}

// packages/debugger/src/source-resolve.ts
import { basename } from "node:path";
var SourceResolutionError = class extends Error {
};
function hasConfigDir(s) {
  return typeof s.configDir === "string";
}
function labelFor(s) {
  return hasConfigDir(s) ? basename(s.configDir) : s.key;
}
function localSourceKeys(healthSources) {
  if (!Array.isArray(healthSources)) return [];
  return healthSources.filter(hasConfigDir).map((s) => s.key);
}
function matchHealthSource(healthSources, wanted) {
  return healthSources.find((s) => s.key === wanted || hasConfigDir(s) && (s.configDir === wanted || s.configDir.endsWith(`/${wanted}`)));
}
function matchSourcesListEntry(list, wanted) {
  return list.find((s) => s.key === wanted || s.label === wanted || typeof s.configDir === "string" && (s.configDir === wanted || s.configDir.endsWith(`/${wanted}`)));
}
function classifySourceSearch(hits) {
  const unique = [...new Set(hits)];
  if (unique.length === 1) return { kind: "unique", key: unique[0] };
  if (unique.length === 0) return { kind: "none" };
  return { kind: "ambiguous", keys: unique };
}
async function withRetry(attempt, opts) {
  for (let i = 0; i < opts.attempts; i++) {
    const value = await attempt();
    if (value !== null) return { kind: "ok", value };
    if (i < opts.attempts - 1) await opts.sleep(opts.delayMs(i));
  }
  return { kind: "exhausted" };
}
var SOURCE_PROBE_ATTEMPTS = 3;
var sourceProbeDelayMs = (attemptIndex) => [300, 900][attemptIndex] ?? 900;
async function resolveSource(healthSources, wanted, fetchSourcesList, sleep) {
  if (!Array.isArray(healthSources) || healthSources.length === 0) return { prefix: "", key: null, label: "" };
  if (wanted === void 0) {
    const first = healthSources[0];
    return { prefix: `/s/${first.key}`, key: first.key, label: labelFor(first) };
  }
  const bySource = matchHealthSource(healthSources, wanted);
  if (bySource !== void 0) return { prefix: `/s/${bySource.key}`, key: bySource.key, label: labelFor(bySource) };
  const outcome = await withRetry(fetchSourcesList, { attempts: SOURCE_PROBE_ATTEMPTS, delayMs: sourceProbeDelayMs, sleep });
  if (outcome.kind === "exhausted") {
    throw new SourceResolutionError(
      `could not confirm hub sources after ${SOURCE_PROBE_ATTEMPTS} attempts (wanted "${wanted}") \u2014 refusing to guess. Run \`wt-observe status\` to check server health.`
    );
  }
  const pick = matchSourcesListEntry(outcome.value, wanted);
  if (pick === void 0) {
    throw new SourceResolutionError(
      `--source ${wanted} matches no hub source \u2014 available: ${outcome.value.map((s) => `${s.label} (${s.configDir ?? "remote"})`).join(", ")}`
    );
  }
  return { prefix: `/s/${pick.key}`, key: pick.key, label: pick.label };
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
    const hasConfigDir2 = typeof h["configDir"] === "string";
    const hasSources = Array.isArray(h["sources"]);
    if (!hasConfigDir2 && !hasSources) return "not-ours";
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
      const pkg = JSON.parse(readFileSync4(join6(d, "apps", "observe-ui", "package.json"), "utf8"));
      return typeof pkg === "object" && pkg !== null && pkg["name"] === "@workflow-toolbox/observe-ui";
    } catch {
      return false;
    }
  };
  const hasServer = (d) => existsSync2(join6(d, "apps", "observe-ui", "server", "dev-api.ts")) && isObserveApp(d);
  const probe = (d) => hasServer(d) ? d : hasServer(join6(d, "toolkit")) ? join6(d, "toolkit") : null;
  const forced = env["DWT_OBSERVE_ROOT"];
  if (forced !== void 0 && forced.length > 0) return probe(forced);
  let dir = cwd;
  for (let depth = 0; depth < 64; depth++) {
    const hit = probe(dir) ?? probe(join6(dir, "workflow-observatory"));
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
    return parseObservePidfile(readFileSync4(path, "utf8"));
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
    unlinkSync3(join6(stateRoot, "hub.json"));
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
  const stateRoot = observeStateRoot(process.env, homedir3(), process.platform);
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
  const configRoot = observeConfigRoot(process.env, homedir3(), process.platform);
  const { sources: configSources } = readObserveConfig(configRoot);
  const discoveryCandidates = discoverConfigDirCandidates(process.env, homedir3());
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
  const configRoot = observeConfigRoot(process.env, homedir3(), process.platform);
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
    if (existsSync2(join6(candidate, ".claude-plugin", "plugin.json"))) return candidate;
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
  const logStartOffset = (() => {
    try {
      return statSync2(logPath).size;
    } catch {
      return 0;
    }
  })();
  const token = randomBytes(24).toString("hex");
  const launchAgentsDir = resolveLaunchAgentsDir();
  const tsxCli = (() => {
    try {
      return createRequire(join6(base, "package.json")).resolve("tsx/cli");
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
  const h = await awaitSpawnedServerReady({
    requestedPort: port,
    timeoutMs: SPAWN_READY_TIMEOUT_MS,
    readLogSlice: () => readLogSliceFrom(logPath, logStartOffset),
    probe: (p) => probeHealth(p),
    // Accept EITHER health shape (the readiness poll must not assume cardinality).
    isReady: (v) => typeof v === "object" && (Array.isArray(v.sources) || typeof v.configDir === "string"),
    spawnState: () => ({ error: spawnError, exited }),
    kill: () => {
      if (typeof child.pid === "number") {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
        }
      }
    },
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logTail: () => logTail(logPath)
  });
  return { health: h, token };
}
function readLogSliceFrom(path, offset) {
  try {
    const buf = readFileSync4(path);
    return buf.subarray(Math.min(offset, buf.length)).toString("utf8");
  } catch {
    return "";
  }
}
function logTail(logPath, lines = 5) {
  try {
    const text = readFileSync4(logPath, "utf8");
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
  return { port: p.health.port, token, health: p.health };
}
async function api(port, token, path, init = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "x-observe-token": token, ...init.body !== void 0 ? { "content-type": "application/json" } : {}, ...init.headers ?? {} },
    signal: AbortSignal.timeout(timeoutMs)
  });
}
async function resolveSourcePrefix(port, token, health, wanted) {
  return resolveSource(
    health.sources,
    wanted,
    () => api(port, token, "/api/sources", {}, 1e4).then((r) => r.ok ? r.json() : null).catch(() => null).then((body) => {
      const raw = typeof body === "object" && body !== null ? body["sources"] : void 0;
      return Array.isArray(raw) ? raw : null;
    }),
    (ms) => new Promise((r) => setTimeout(r, ms))
  );
}
var WEB_AVAILABLE_V0 = true;
async function applySidecarCapabilities(input) {
  const { port, token, prefix, script, args, callerCapabilities, requesterCwd } = input;
  if (!input.sourceIsLocal) return args;
  let workflowPath;
  try {
    const list = await api(port, token, `${prefix}/api/workflows`).then(
      (r) => r.ok ? r.json() : [],
      () => []
    );
    const entry = Array.isArray(list) ? list.find((w) => w.id === script) : void 0;
    if (entry !== void 0 && typeof entry.path === "string") workflowPath = entry.path;
  } catch {
    workflowPath = void 0;
  }
  if (workflowPath === void 0) return args;
  const sidecarPath = sidecarPathFor(workflowPath);
  let rawSidecar;
  try {
    rawSidecar = readFileSync4(sidecarPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return args;
    throw new Error(`capability sidecar ${sidecarPath} is present but unreadable: ${String(e)}`);
  }
  let sidecar;
  try {
    sidecar = JSON.parse(rawSidecar);
  } catch (e) {
    throw new Error(`capability sidecar ${sidecarPath} is not valid JSON: ${e.message}`);
  }
  const { registry, availability } = await input.loadCapContext();
  const composed = composeLaunchCapabilities({ sidecar, registry, availability, webAvailable: WEB_AVAILABLE_V0, requesterCwd, callerCapabilities });
  if (composed.errors.length > 0) {
    throw new Error(`capability sidecar ${sidecarPath} cannot be resolved for launch:
  - ${composed.errors.join("\n  - ")}`);
  }
  const roleCount = isRecord2(sidecar) && isRecord2(sidecar.roles) ? Object.keys(sidecar.roles).length : 0;
  process.stderr.write(`capability sidecar: resolved ${composed.report.length} need(s) across ${roleCount} role(s) from ${sidecarPath}
`);
  return foldCapabilitiesIntoArgs(args, composed.capabilities, composed.report, script);
}
function inlineObserverRequires(entry) {
  if (!isRecord2(entry) || !isRecord2(entry["definition"])) return null;
  const req = entry["definition"]["requires"];
  return Array.isArray(req) && req.length > 0 ? req : null;
}
async function applyObserverResolution(input) {
  const { args, requesterCwd, loadCapContext } = input;
  if (!isRecord2(args) || !Array.isArray(args["observers"])) return args;
  const observers = args["observers"];
  const hasInline = observers.some((e) => inlineObserverRequires(e) !== null);
  const hasDefinitionFile = observers.some((e) => isRecord2(e) && typeof e["definitionFile"] === "string");
  if (!hasInline && !hasDefinitionFile) return args;
  let ctx = null;
  let registryPresent = false;
  if (hasInline) {
    ctx = await loadCapContext();
    registryPresent = Object.keys(ctx.registry.providers).length > 0;
  } else {
    const probe = loadCapabilityRegistry();
    registryPresent = probe.errors.length === 0 && Object.keys(probe.registry.providers).length > 0;
  }
  for (const w of observerDefinitionFileWarnings(observers, registryPresent)) process.stderr.write(`${w}
`);
  if (!hasInline || ctx === null) return args;
  const { registry, availability } = ctx;
  let resolved = 0;
  const out = observers.map((entry) => {
    const requires = inlineObserverRequires(entry);
    if (requires === null) return entry;
    resolved++;
    return { ...entry, resolution: resolveObserverRequires(requires, registry, availability, WEB_AVAILABLE_V0, requesterCwd) };
  });
  process.stderr.write(`observer requires: resolved needs for ${resolved} inline observer definition(s)
`);
  return { ...args, observers: out };
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
  const cap = extractCapabilities(args);
  if (cap.errors.length > 0) throw new Error(`--args capabilities section invalid:
  - ${cap.errors.join("\n  - ")}`);
  const obs = extractObservers(args);
  if (obs.errors.length > 0) throw new Error(`--args observers section invalid:
  - ${obs.errors.join("\n  - ")}`);
  if (obs.entries !== null && obs.entries.length > 0) {
    const names = obs.entries.map((e) => "definition" in e ? e.definition.name : e.definitionFile);
    process.stderr.write(
      `observers section: ${names.join(", ")} \u2014 needs a server with observer attachment; older servers ignore it
`
    );
  }
  const { port, token, health } = await requireOwnedServer(ctx);
  const { prefix, label, key: resolvedKey } = await resolveSourcePrefix(port, token, health, sourceFlag);
  if (label !== "") process.stderr.write(`launching under source ${label}
`);
  const sourceIsLocal = resolvedKey === null || localSourceKeys(health.sources).includes(resolvedKey);
  const { cwd: requesterCwd, note: cwdNote } = safeRequesterCwd(() => process.cwd());
  if (cwdNote !== null) process.stderr.write(`${cwdNote}
`);
  let capContext = null;
  const loadCapContext = async () => {
    if (capContext === null) {
      const { registry, errors } = loadCapabilityRegistry();
      if (errors.length > 0) throw new Error(`capability registry invalid:
  - ${errors.join("\n  - ")}`);
      capContext = { registry, availability: await probeProviders(registry) };
    }
    return capContext;
  };
  args = await applySidecarCapabilities({ port, token, prefix, script, args, callerCapabilities: cap.spec, requesterCwd, loadCapContext, sourceIsLocal });
  args = await applyObserverResolution({ args, requesterCwd, loadCapContext });
  const finalCap = extractCapabilities(args);
  if (finalCap.errors.length > 0) throw new Error(`composed capabilities section invalid:
  - ${finalCap.errors.join("\n  - ")}`);
  if (finalCap.spec !== null) {
    process.stderr.write(
      `capabilities section: ${Object.keys(composeCapabilityOptions(finalCap.spec)).join(", ") || "(empty)"} \u2014 needs a server with capabilities composition; older servers ignore it
`
    );
  }
  const res = await api(port, token, `${prefix}/api/launch`, { method: "POST", body: JSON.stringify(buildLaunchBody(script, args, requesterCwd)) }, 3e4);
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
async function searchLocalSources(port, token, keys, runId) {
  const hits = [];
  await Promise.all(
    keys.map(async (key) => {
      const p = `/s/${key}`;
      const live = await api(port, token, `${p}/api/runs/live`).then((r) => r.ok ? r.json() : []).catch(() => []);
      if (live.some((e) => e.runId === runId)) {
        hits.push(key);
        return;
      }
      const recall = await fetchRecall(port, token, p, runId);
      if (recall !== null) hits.push(key);
    })
  );
  return classifySourceSearch(hits);
}
async function cmdAwait(ctx, runId, timeoutS, pollS, sourceFlag) {
  if (runId === void 0) throw new Error("usage: wt-observe await <runId> [--timeout-s N] [--poll-s N] [--source <label|dir>]");
  const { port, token, health } = await requireOwnedServer(ctx);
  let resolved;
  try {
    resolved = await resolveSourcePrefix(port, token, health, sourceFlag);
  } catch (err) {
    if (err instanceof SourceResolutionError) {
      process.stdout.write(`${JSON.stringify({ runId, error: "source-unresolved", message: err.message })}
`);
      return AWAIT_SOURCE_UNRESOLVED_EXIT_CODE;
    }
    throw err;
  }
  let prefix = resolved.prefix;
  let activeKey = resolved.key;
  const searchableKeys = sourceFlag === void 0 ? localSourceKeys(health.sources) : [];
  let warnedAmbiguous = false;
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
    if (entry === null && recall === null && searchableKeys.length > 1) {
      const search = await searchLocalSources(port, token, searchableKeys, runId);
      if (search.kind === "unique" && search.key !== activeKey) {
        process.stderr.write(`[wt-observe await] "${runId}" found under source "${search.key}" (default was "${String(activeKey)}") \u2014 switching.
`);
        activeKey = search.key;
        prefix = `/s/${search.key}`;
        continue;
      }
      if (search.kind === "ambiguous" && !warnedAmbiguous) {
        warnedAmbiguous = true;
        process.stderr.write(
          `[wt-observe await] "${runId}" ambiguously found under multiple sources (${search.keys.join(", ")}) \u2014 refusing to guess, staying on "${String(activeKey)}".
`
        );
      }
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
      const reasonPart = status !== "completed" && outcome.error !== null ? { error: truncateAwaitError(outcome.error) } : {};
      process.stdout.write(`${JSON.stringify({ runId, status, result: outcome.result, ...reasonPart })}
`);
      if ("error" in reasonPart) process.stderr.write(`[wt-observe await] ${runId} ${status}: ${reasonPart.error}
`);
      return awaitExitCode({ kind: "done", status });
    }
    process.stdout.write(`${JSON.stringify({ runId, error: verdict.kind })}
`);
    return awaitExitCode(verdict);
  }
}
async function cmdResume(ctx, runId, sourceFlag) {
  if (runId === void 0) throw new Error("usage: wt-observe resume <runId> [--source <label|dir>]");
  const { port, token, health } = await requireOwnedServer(ctx);
  let resolved;
  try {
    resolved = await resolveSourcePrefix(port, token, health, sourceFlag);
  } catch (err) {
    if (err instanceof SourceResolutionError) {
      process.stdout.write(`${JSON.stringify({ runId, error: "source-unresolved", message: err.message })}
`);
      return AWAIT_SOURCE_UNRESOLVED_EXIT_CODE;
    }
    throw err;
  }
  if (resolved.label !== "") process.stderr.write(`recovering under source ${resolved.label}
`);
  const res = await api(port, token, `${resolved.prefix}/api/runs/${encodeURIComponent(runId)}/recover`, { method: "POST" }, 3e4);
  const body = await res.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? body : {};
  const code = typeof record["code"] === "string" ? record["code"] : void 0;
  if (res.ok) {
    process.stdout.write(`${JSON.stringify(body)}
`);
  } else {
    const errorMsg = typeof record["error"] === "string" ? record["error"] : `http ${res.status}`;
    process.stdout.write(`${JSON.stringify({ runId, error: errorMsg, ...code !== void 0 ? { code } : {} })}
`);
  }
  return recoverExitCodeFor(res.status, res.ok, code);
}
async function cmdConfigShow() {
  const configRoot = observeConfigRoot(process.env, homedir3(), process.platform);
  const configPath = join6(configRoot, "config.json");
  const { sources, remotes } = readObserveConfig(configRoot);
  const discovered = [...new Set(discoverConfigDirCandidates(process.env, homedir3()).map(resolveDir))];
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
  const configRoot = observeConfigRoot(process.env, homedir3(), process.platform);
  const config = readObserveConfig(configRoot);
  const already = config.sources.some((s) => resolveDir(s) === dir);
  const next = already ? config.sources : [...config.sources, dir];
  writeObserveConfig(configRoot, { ...config, sources: next });
  process.stdout.write(`sources: ${next.join(", ")}
`);
}
async function cmdConfigRemoveSource(dirRaw) {
  const dir = resolveDir(dirRaw);
  const configRoot = observeConfigRoot(process.env, homedir3(), process.platform);
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
  const configRoot = observeConfigRoot(process.env, homedir3(), process.platform);
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
  const configRoot = observeConfigRoot(process.env, homedir3(), process.platform);
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
    const projectsDir = join6(configDir, "projects");
    const scriptByRun = /* @__PURE__ */ new Map();
    for (const slug of subdirs(projectsDir)) {
      for (const session of subdirs(join6(projectsDir, slug))) {
        const scriptsDir = join6(projectsDir, slug, session, "workflows", "scripts");
        for (const f of filesIn(scriptsDir)) {
          const m = RUNID_IN_SCRIPT.exec(f);
          if (m) scriptByRun.set(m[1], { name: runNameFromScript(f, m[1]), scriptPath: join6(scriptsDir, f) });
        }
      }
    }
    for (const slug of subdirs(projectsDir)) {
      for (const session of subdirs(join6(projectsDir, slug))) {
        const wfDir = join6(projectsDir, slug, session, "workflows");
        for (const f of filesIn(wfDir)) {
          const m = RUN_JSON.exec(f);
          if (!m) continue;
          const runId = m[1];
          const jsonPath = join6(wfDir, f);
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
            sidecarDir: join6(projectsDir, slug, session, "subagents", "workflows", runId)
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
  const configDirs = [...new Set(discoverConfigDirCandidates(process.env, homedir3()).map(resolveDir))];
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
    } else if (cmd === "resume") {
      return await cmdResume(ctx, argv[1], flagValue(argv, "source"));
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
        "usage: wt-observe [start [--source <dir>]... [--watch] [--enable-launch]|stop|status|launch <workflow.js> [--args <json>] [--source <label|dir>]|await <runId> [--timeout-s N] [--poll-s N] [--source <label|dir>]|resume <runId> [--source <label|dir>]|config [show|add-source <dir>|remove-source <dir>|add-remote <url> [--token <t>|--token-file <p>] [--label <l>]|remove-remote <url>]]\n"
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
