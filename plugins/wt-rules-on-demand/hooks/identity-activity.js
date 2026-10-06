// Latest facts join independently, including facts for distinct migration generations and writer runs.
const valid = (at) => typeof at === 'string' && Number.isFinite(Date.parse(at));
const fields = ['loadedAt', 'servedAt', 'reportedAt'];
function joinTimes(target, row) {
  for (const field of fields) if (valid(row?.[field]) && (!valid(target[field]) || Date.parse(row[field]) > Date.parse(target[field]))) target[field] = row[field];
}

function joinGenerations(target, row) {
  joinTimes(target, row);
  for (const [generation, record] of Object.entries(row?.generations ?? {})) {
    target.generations ??= {};
    target.generations[generation] ??= {};
    joinTimes(target.generations[generation], record);
  }
}

function joinHealthCalls(target, row) {
  for (const field of ['healthCalls', 'healthTotals']) for (const [day, count] of Object.entries(row?.[field] ?? {})) {
    if (!Number.isFinite(count) || count < 0) continue;
    target[field] ??= {};
    target[field][day] = Math.max(target[field][day] ?? 0, count);
  }
}

export function mergeActivityRow(target, row) {
  joinGenerations(target, row);
  joinHealthCalls(target, row);
  for (const [run, writer] of Object.entries(row?.writers ?? {})) {
    target.writers ??= {};
    const record = target.writers[run] ??= { profile: writer.profile };
    if (record.profile !== writer.profile) record.profile = null;
    joinGenerations(record, writer);
    joinHealthCalls(record, writer);
  }
  return target;
}

export function joinIdentityActivity(...sources) {
  const out = {};
  for (const source of sources) for (const [identity, row] of Object.entries(source ?? {})) {
    out[identity] ??= {};
    mergeActivityRow(out[identity], row);
  }
  return out;
}

export function stampActivity(source, profile, run) {
  return Object.fromEntries(Object.entries(source).map(([identity, row]) => [identity,
    { ...row, writers: { [run]: { ...row, profile } } }]));
}

export function healthActivity(source, batch, health, profile, run, now) {
  const prior = source?.['@capability']?.writers?.[run];
  const writer = { profile, reportedAt: now, healthCalls: { ...prior?.healthCalls }, healthTotals: { ...prior?.healthTotals } };
  for (const [day, counts] of Object.entries(batch.days)) {
    writer.healthCalls[day] = (writer.healthCalls[day] ?? 0) + counts.calls;
    writer.healthTotals[day] = health.days[day].calls;
  }
  return joinIdentityActivity(source, { '@capability': { reportedAt: now, writers: { [run]: writer } } });
}

// The comment stays in generated frontmatter, never in the restored static body.
export const migrationGeneration = (text) => /^# migration-generation: ([a-f0-9-]+)$/m.exec(text)?.[1];

function activityRow(row, generation, field, now) {
  row[field] = now;
  row.reportedAt = now;
  if (generation) {
    row.generations ??= {};
    row.generations[generation] ??= {};
    row.generations[generation][field] = now;
  }
  return row;
}

export function noteActivity(pending, writes, rules, field, now) {
  const capability = 'reportedAt:@capability';
  if (!writes.has(capability) || Date.parse(now) - writes.get(capability) >= 600_000) {
    writes.set(capability, Date.parse(now));
    pending.set('@capability', { reportedAt: now });
  }
  for (const { identity, generation } of rules) {
    if (!identity) continue;
    const slot = `${field}:${identity}:${generation ?? ''}`;
    if (writes.has(slot) && Date.parse(now) - writes.get(slot) < 600_000) continue;
    writes.set(slot, Date.parse(now));
    pending.set(identity, activityRow(pending.get(identity) ?? {}, generation, field, now));
  }
}
