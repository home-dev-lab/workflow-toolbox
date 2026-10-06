import { configDirectory } from '../paths.js';
import { ownerNumber } from './owner-number.js';
import { sessionKey } from '../session-key.mjs';

// Pure plans: only hooks.js touches the host handle. Stable session slots survive
// reloads; a fresh token identifies the load that wrote each active record.
const token = () => `${ownerNumber(52, Math.random).toString(36)}-${ownerNumber(52, Math.random).toString(36)}`;
function text(value, max = 160) {
  let result = typeof value === 'string' ? value.slice(0, max) : '';
  while (JSON.stringify(result).length > max + 2) result = result.slice(0, Math.floor(result.length * 0.75));
  return result;
}
const rows = (value) => Array.isArray(value) ? value : [];
const safeName = (name) => typeof name === 'string' && /^[A-Za-z0-9._-]+\.json$/.test(name);
export const MAX_CONCURRENT_FLIGHTS = 32;
const occupied = new Set();
let loadToken = token(), metadata = null, harvestDone = false;

export function resetFlightRecorder() {
  loadToken = token();
  occupied.clear();
  metadata = null;
  harvestDone = false;
}

function* request(op, path, value) {
  return yield { op, path, value };
}

export function* prepareFlight() {
  const env = {};
  for (const name of ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE']) {
    env[name] = (yield* request('env', name))?.value;
  }
  const config = configDirectory(env);
  const sessionId = (yield* request('session'))?.value;
  if (!config || typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || JSON.stringify(sessionId).length > 514) return;
  metadata = { directory: `${config}/plugins/data/wt-rules-on-demand/inflight`, sessionId, key: sessionKey(sessionId) };
}

// Count direct strings only. Iterate without materialising input values or
// serialising nested objects; saturating the estimate also bounds the scan.
function inputCharacters(event) {
  const input = event.input ?? event;
  if (typeof input === 'string') return Math.min(input.length, 1_000_000);
  let size = 0;
  for (const name in input) {
    if (!Object.hasOwn(input, name)) continue;
    if (typeof input[name] === 'string') size = Math.min(1_000_000, size + input[name].length);
    if (size === 1_000_000) break;
  }
  return size;
}

function claimSlot() {
  for (let index = 0; index < MAX_CONCURRENT_FLIGHTS; index++) {
    const path = `${metadata.directory}/${metadata.key}-${index}.json`;
    if (occupied.has(path)) continue;
    occupied.add(path);
    return path;
  }
  return null;
}

export function startFlight(event, work, started) {
  if (!metadata) return null;
  const { sessionId } = metadata;
  const row = { work, tool: work === 'tool.call' ? text(event.tool) : '', inputChars: inputCharacters(event),
    phase: 'work', startedAt: new Date(started).toISOString(), sessionId, loadToken };
  if (event.agentId !== undefined) row.agentId = text(event.agentId, 128);
  const path = claimSlot();
  // Saturation loses breadcrumb coverage, never serving or completed-call timing.
  if (!path) return { row, available: true };
  return { path, row, available: true };
}

export function* entryFlight(flight) {
  if (!flight?.path) return;
  const response = yield* request('write', flight.path, JSON.stringify(flight.row));
  flight.available = response?.error?.name !== 'TypeError';
}

export function* finallyFlight(flight) {
  if (!flight?.path) return;
  flight.row.phase = 'finally';
  yield* request('write', flight.path, JSON.stringify(flight.row));
}

export function* completeFlight(flight) {
  if (!flight?.path) return;
  flight.row.phase = 'complete';
  let response = yield* request('write', flight.path, JSON.stringify(flight.row));
  if (response?.error) response = yield* request('write', flight.path, JSON.stringify(flight.row));
  if (!response?.error) occupied.delete(flight.path);
}

function normalizedBreadcrumb(row) {
  return { work: text(row.work, 64), tool: text(row.tool), inputChars: Math.min(1_000_000, Math.max(0, Number(row.inputChars) || 0)),
    phase: row.phase, startedAt: new Date(row.startedAt).toISOString(), sessionId: text(row.sessionId, 512),
    loadToken: text(row.loadToken, 128), ...(row.agentId === undefined ? {} : { agentId: text(row.agentId, 128) }) };
}

function validBreadcrumb(row) {
  return row && Number.isFinite(Date.parse(row.startedAt)) && ['work', 'finally'].includes(row.phase)
    && typeof row.sessionId === 'string' && typeof row.loadToken === 'string';
}

function parsedBreadcrumb(content) {
  if (typeof content !== 'string' || content.length > 4096) return null;
  try {
    const row = JSON.parse(content);
    return validBreadcrumb(row) ? normalizedBreadcrumb(row) : null;
  } catch { return null; }
}

function harvestLine(row) {
  return `wt-rules-on-demand: call did not confirm completion: ${row.work} (${row.tool || 'no tool'}), last phase ${row.phase}, `
    + `${row.inputChars} input chars, started at ${row.startedAt}; found after the hooks module reloaded`;
}

function* harvestEntry(entry, directory, sessionId) {
  // Only this session's slots are read: other sessions' files would cost one host read each.
  if (!safeName(entry?.name) || !entry.name.startsWith(`${metadata.key}-`)) return null;
  const path = `${directory}/${entry.name}`;
  const response = yield* request('read', path);
  // Unreadable local slots must not be overwritten: they may hold crash evidence.
  if (response?.error) { occupied.add(path); return false; }
  occupied.delete(path);
  const row = parsedBreadcrumb(response?.value);
  if (!row || row.loadToken === loadToken) return null;
  if (row.sessionId !== sessionId) return null;
  occupied.add(path);
  return { path, row };
}

// The host rethrows a failed list as "<plugin>: ...list(<path>) failed: <errno>", with no code property.
function missingDirectory(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return error?.code === 'ENOENT' || message.startsWith('ENOENT:') || / failed: ENOENT$/.test(message);
}

function* scanFlights(listing, directory, sessionId) {
  const harvested = [];
  let complete = true;
  for (const entry of rows(listing)) {
    const record = yield* harvestEntry(entry, directory, sessionId);
    if (record === false) complete = false;
    if (record) harvested.push(record);
  }
  return complete ? harvested : null;
}

export function* harvestFlight() {
  if (!metadata) return null;
  if (harvestDone) return [];
  const { directory, sessionId } = metadata;
  const response = (yield* request('list', directory)) ?? {};
  if (missingDirectory(response.error)) { harvestDone = true; return []; }
  // Unknown disk state stays protected until a later event can retry the scan.
  if (response.error || !Array.isArray(response.value)) return null;
  const listing = response.value;
  const harvested = yield* scanFlights(listing, directory, sessionId);
  harvestDone = harvested !== null;
  return harvested;
}

export function* markHarvested(harvested) {
  if (!metadata) return;
  // At-least-once announcements: log before marking; a failed mark can duplicate the line after reload.
  for (const { path, row } of harvested) {
    const logged = yield* request('log', harvestLine(row));
    if (logged?.error) continue;
    const response = yield* request('write', path, JSON.stringify({ ...row, phase: 'harvested' }));
    if (response?.error) continue;
    occupied.delete(path);
  }
}

function recentInterruptions(previous, incoming) {
  const unique = new Map();
  for (const row of [...rows(previous), ...rows(incoming)]) {
    if (typeof row?.startedAt !== 'string') continue;
    unique.set(JSON.stringify([row.path, row.loadToken, row.startedAt]), row);
  }
  return [...unique.values()]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-20);
}

function slowest(previous, incoming) {
  const day = new Date().toISOString().slice(0, 10);
  return [...rows(previous), ...rows(incoming)].filter((row) => typeof row?.at === 'string' && row.at.startsWith(day) && Number.isFinite(row.ms))
    .sort((a, b) => b.ms - a.ms).slice(0, 10);
}

export function mergeFlightHealth(target, batch) {
  if (target.interruptedCalls || batch?.interruptedCalls) target.interruptedCalls = recentInterruptions(target.interruptedCalls, batch?.interruptedCalls);
  if (target.slowestCalls || batch?.slowestCalls) target.slowestCalls = slowest(target.slowestCalls, batch?.slowestCalls);
}

export function noteFlightCall(health, flight, ms) {
  try {
    // Older hosts/fixtures without file writes retain their existing health shape.
    if (!flight?.available) return;
    const { work, tool, inputChars } = flight.row;
    mergeFlightHealth(health, { slowestCalls: [{ work, tool, ms: Math.max(0, ms), inputChars, at: new Date().toISOString() }] });
  } catch { /* Diagnostics cannot affect serving. */ }
}
