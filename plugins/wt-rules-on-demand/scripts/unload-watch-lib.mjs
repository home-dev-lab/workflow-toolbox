export const FIRST_SCAN_CAP = 4 * 1024 * 1024;
export const INCREMENTAL_CAP = 16 * 1024 * 1024;
const WARNING_INTERVAL = 10 * 60 * 1000;
const prefix = 'wt-rules-on-demand: ';
const unloadContent = `${prefix}wt-rules-on-demand was unloaded: it crashed the hooks worker`;
const alivePrefixes = [
  `${prefix}plugin.json changed — reloaded`,
  `${prefix}hooks.json changed — reloaded`,
  `${prefix}wt-rules-on-demand: serving`,
  `${prefix}wt-rules-on-demand: before-act refusal serving`,
  `${prefix}wt-rules-on-demand: interrupted call`,
  `${prefix}wt-rules-on-demand: reached finally, completion not confirmed`,
];
const time = (value) => typeof value === 'string' ? Date.parse(value) : NaN;
const timestamp = (value) => Number.isFinite(time(value)) ? value : null;

function initialState(state) {
  return { offset: 0, unloadedAt: timestamp(state?.unloadedAt),
    aliveAt: timestamp(state?.aliveAt), warnedAt: timestamp(state?.warnedAt), lastEvidence: state?.lastEvidence ?? null };
}

// A capped scan may start inside a row; the I/O adapter checks the preceding byte too.
export function scanPlan(size, state) {
  const validOffset = Number.isSafeInteger(state?.offset) && state.offset >= 0 && state.offset <= size;
  const offset = validOffset ? state.offset : 0;
  const cap = validOffset ? INCREMENTAL_CAP : FIRST_SCAN_CAP;
  const start = Math.max(offset, size - cap);
  return { start, length: size - start, align: start > offset, state: initialState(state) };
}

function evidence(row) {
  if (row?.type !== 'system' || typeof row.content !== 'string') return null;
  if (row.subtype === 'local_command') {
    // /reload-plugins prints one global summary ("Reloaded: 13 plugins · …") that names no plugin.
    return /Reloaded: \d+ plugins?\b/.test(row.content) ? 'aliveAt' : null;
  }
  if (row.subtype !== 'informational') return null;
  if (row.content === unloadContent) return 'unloadedAt';
  return alivePrefixes.some((start) => row.content.startsWith(start)) ? 'aliveAt' : null;
}

function observeLine(state, line) {
  let row;
  try { row = JSON.parse(line); } catch { return; }
  const field = evidence(row);
  if (field && timestamp(row.timestamp)) {
    state[field] = row.timestamp;
    state.lastEvidence = field;
  }
}

// Offsets count bytes, never decoded UTF-8 characters. An unfinished row stays for the next scan.
export function scanTranscript(bytes, plan) {
  const state = { ...plan.state, offset: plan.start };
  let cursor = 0;
  if (plan.align) {
    const boundary = bytes.indexOf(10);
    if (boundary < 0) return state;
    cursor = boundary + 1;
    state.offset = plan.start + cursor;
  }
  for (let end = bytes.indexOf(10, cursor); end >= 0; end = bytes.indexOf(10, cursor)) {
    observeLine(state, bytes.subarray(cursor, end).toString('utf8'));
    cursor = end + 1;
    state.offset = plan.start + cursor;
  }
  return state;
}

function warningText(unloadedAt) {
  return `The rules-on-demand engine was unloaded by the host at ${new Date(time(unloadedAt)).toISOString()} `
    + '(its hooks worker missed its heartbeat). Since then no at-act rule is served or refused in this session. '
    + 'A main session restores it with /reload-plugins or a restart; a sub-agent tells its main session.';
}

export function announcement(previous, input, now) {
  const state = { ...previous };
  const sessionStart = input.hook_event_name === 'SessionStart';
  if (sessionStart && ['startup', 'resume'].includes(input.source)) {
    state.aliveAt = now;
    state.lastEvidence = 'aliveAt';
  }
  const unloaded = state.lastEvidence === 'unloadedAt';
  const compact = sessionStart && input.source === 'compact';
  const due = !state.warnedAt || time(now) - time(state.warnedAt) >= WARNING_INTERVAL;
  if (!unloaded || (!compact && !due)) return { state, output: null };
  state.warnedAt = now;
  const text = warningText(state.unloadedAt);
  return { state, output: { systemMessage: text,
    hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text } } };
}
