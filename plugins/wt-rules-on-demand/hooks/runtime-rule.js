import { CHECKS } from './act-checks.js';
import { RULE_CAP, safeRegex } from './evidence.js';

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  return trimmed;
}

// Every key a rule may declare. A key outside these lists is REFUSED, never ignored: an
// ignored predicate fails open — a `tool` trigger whose narrowing key the engine does not know fires on every call.
// scripts/rule-lifecycle-lib.mjs validates a migration spec against the same lists.
export const TRIGGER_KEYS = Object.freeze(['kind', 'regex', 'tool', 'flags', 'unconditional', 'before-first-act', 'mentions', 'input-regex', 'command-head']);
export const COMPLIANCE_KEYS = Object.freeze(['kind', 'check', 'reason', 'window', 'on-close', 'flags', 'model', 'prompt', 'act-regex', 'require-regex', 'require-all', 'test-regex', 'path-regex', 'tool', 'require-input-regex', 'require-any-input-regex', 'forbid-input-regex', 'absent-input-key', 'exempt-regex', 'id-regex', 'follow-up-tool', 'value-regex', 'min-distinct', 'input-field', 'mask-code', 'when-input-regex', 'each-line-regex', 'match-block-regex', 'minimum-input-key', 'minimum-input-value', 'forbid-pipe', 'subject-input-key', 'subject-input-regex', 'identity-pair', 'reject-bash-regex',
   // Not read by the engine: scripts/rollback-check.mjs reads them from the file (TRIGGERS.md, rollback).
  'rollback-threshold', 'rollback-min-samples']);

export function assertKnownKeys(keys, known, what) {
  const unknown = keys.filter((key) => !known.includes(key));
  if (unknown.length) throw new Error(`unknown ${what} key: ${unknown.join(', ')} (known: ${known.join(', ')})`);
}

function parseCompliance(lines, complianceAt, name) {
  if (complianceAt === -1) return null;
  const data = {};
  for (const line of lines.slice(complianceAt + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const property = /^ {4}([a-z-]+):/.exec(line);
    if (!property) throw new Error(`unsupported compliance line: ${line.trim()}`);
    assertKnownKeys([property[1]], COMPLIANCE_KEYS, 'compliance');
    data[property[1]] = scalar(line.slice(property[0].length));
  }
  if (data.kind === 'none') {
    if (!data.reason?.trim()) throw new Error('compliance.none requires reason');
    return null;
  }
  if (data.kind === 'check') {
    if (!data.check) throw new Error('compliance.check requires a name');
    if (!CHECKS.includes(data.check)) return { kind: 'unregistered', check: data.check, reason: `unregistered check ${data.check}` };
    return { kind: 'check', check: data.check };
  }
  const window = Number(data.window);
  if (!Number.isInteger(window) || window < 1) throw new Error('compliance.window must be a positive integer');
  if (data['on-close'] !== 'not applicable') throw new Error('compliance.on-close must be not applicable');
  const flags = data.flags ?? '';
  if (!/^[imsu]*$/.test(flags)) throw new Error(`unsupported compliance regex flags: ${flags}`);
  if (data.model) return { kind: 'model', model: data.model, prompt: data.prompt ?? '', window, onClose: data['on-close'] };
  if (data.kind === 'bash-command') {
    if (!data['act-regex'] || (!data['require-regex'] && !data['require-all'])) throw new Error('bash-command compliance requires act-regex and require-regex or require-all');
    if (data['forbid-pipe'] && !['true', 'false'].includes(data['forbid-pipe'])) throw new Error('forbid-pipe must be true or false');
    return {
      kind: data.kind,
       act: safeRegex(name, data['act-regex'], flags),
       require: data['require-regex'] ? safeRegex(name, data['require-regex'], flags) : null,
       exempt: data['exempt-regex'] ? safeRegex(name, data['exempt-regex'], flags) : null,
       forbidPipe: data['forbid-pipe'] === 'true',
      requireAll: data['require-all'] ? data['require-all'].split('||').map((part) => part.trim()).filter(Boolean) : [],
      flags,
      window,
      onClose: data['on-close'],
    };
  }
  if (data.kind === 'tool-input') {
    if (!data.tool || !data['require-input-regex'] && !data['require-any-input-regex']) throw new Error('tool-input requires tool and require-input-regex or require-any-input-regex');
    if (data['mask-code'] && !['true', 'false'].includes(data['mask-code'])) throw new Error('mask-code must be true or false');
    if (data['minimum-input-key'] && (!Number.isFinite(Number(data['minimum-input-value'])) || !data['minimum-input-value'])) throw new Error('minimum-input-key requires a finite minimum-input-value');
    return { kind: data.kind, tool: safeRegex(name, data.tool, flags), required: data['require-input-regex'] ? data['require-input-regex'].split('||').map((part) => safeRegex(name, part.trim(), flags)) : [],
      any: data['require-any-input-regex'] ? data['require-any-input-regex'].split('||').map((part) => safeRegex(name, part.trim(), flags)) : [],
      forbidden: data['forbid-input-regex'] ? safeRegex(name, data['forbid-input-regex'], flags) : null,
      path: data['path-regex'] ? safeRegex(name, data['path-regex'], flags) : null,
       absentKey: data['absent-input-key'] ?? null,
       rejectBash: data['reject-bash-regex'] ? safeRegex(name, data['reject-bash-regex'], flags) : null,
       inputField: data['input-field'] ?? null, maskCode: data['mask-code'] === 'true',
       when: data['when-input-regex'] ? safeRegex(name, data['when-input-regex'], flags) : null,
       eachLine: data['each-line-regex'] ? safeRegex(name, data['each-line-regex'], flags) : null,
       matchBlock: data['match-block-regex'] ? safeRegex(name, data['match-block-regex'], flags, { capture: true }) : null,
       minimumKey: data['minimum-input-key'] ?? null,
       minimumValue: data['minimum-input-value'] === undefined ? null : Number(data['minimum-input-value']),
       window, onClose: data['on-close'] };
  }
  if (data.kind === 'turn-correlation') {
    if (!data.tool || !data['id-regex'] || !data['value-regex'] || (!data['follow-up-tool'] && !data['act-regex'])) throw new Error('turn-correlation requires tool, id-regex, value-regex and follow-up-tool or act-regex');
    const minDistinct = Number(data['min-distinct']);
    if (!Number.isInteger(minDistinct) || minDistinct < 1) throw new Error('min-distinct must be a positive integer');
    return { kind: data.kind, tool: safeRegex(name, data.tool, flags), id: safeRegex(name, data['id-regex'], flags, { capture: true }),
      value: safeRegex(name, data['value-regex'], flags, { capture: true }), followUpTool: data['follow-up-tool'] ? safeRegex(name, data['follow-up-tool'], flags) : null,
      act: data['act-regex'] ? safeRegex(name, data['act-regex'], flags) : null,
      subjectInputKey: data['subject-input-key'] ?? null,
      subjectInput: data['subject-input-regex'] ? safeRegex(name, data['subject-input-regex'], flags) : null,
      identityPair: data['identity-pair'] === 'true', minDistinct, window, onClose: data['on-close'] };
  }
  if (data.kind === 'test-before-edit') {
    if (!data['test-regex'] || !data['path-regex']) throw new Error('test-before-edit compliance requires test-regex and path-regex');
    return {
      kind: data.kind,
       test: safeRegex(name, data['test-regex'], flags),
       path: safeRegex(name, data['path-regex'], flags),
      window,
      onClose: data['on-close'],
    };
  }
  throw new Error(`unknown compliance kind: ${data.kind ?? '(missing)'}`);
}

export function parseRuntimeRule(name, text, { rawTriggers = false } = {}) {
  if (new TextEncoder().encode(text).length > RULE_CAP) throw new Error(`${name}: rule exceeds ${RULE_CAP} bytes`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('missing YAML frontmatter');
  const lines = match[1].split(/\r?\n/);
  if (lines[0] !== 'on-demand:' || lines[1] !== '  triggers:') throw new Error('expected on-demand.triggers list');
  const complianceAt = lines.indexOf('  compliance:');
  const triggerLines = complianceAt === -1 ? lines.slice(2) : lines.slice(2, complianceAt);
  const records = [];
  let record;
  for (const line of triggerLines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const item = /^ {4}- ([a-z-]+):/.exec(line);
    const property = /^ {6}([a-z-]+):/.exec(line);
    if (item) {
      record = { [item[1]]: scalar(line.slice(item[0].length)) };
      records.push(record);
    } else if (property && record) {
      record[property[1]] = scalar(line.slice(property[0].length));
    } else {
      throw new Error(`unsupported frontmatter line: ${line.trim()}`);
    }
  }
  if (!records.length) throw new Error('on-demand.triggers must not be empty');
  const triggers = records.map((entry) => {
    assertKnownKeys(Object.keys(entry), TRIGGER_KEYS, 'trigger');
    if (!['bash', 'prompt', 'tool', 'path'].includes(entry.kind)) throw new Error(`unknown trigger kind: ${entry.kind ?? '(missing)'}`);
    const flags = entry.flags ?? '';
    if (!/^[imsu]*$/.test(flags)) throw new Error(`unsupported regex flags: ${flags}`);
    if (['bash', 'prompt', 'path'].includes(entry.kind) && !entry.regex) throw new Error(`${entry.kind} trigger requires regex`);
    if (['tool', 'path'].includes(entry.kind) && !entry.tool) throw new Error(`${entry.kind} trigger requires tool`);
    // `input-regex` — a `tool` trigger that fires only when the regex matches the JSON of the call's arguments
    // (hooks.js toolInputText). It narrows and never widens: no input at runtime means no fire.
    if (entry['input-regex'] !== undefined && entry.kind !== 'tool') throw new Error('input-regex applies to tool triggers only');
    if (entry['input-regex'] !== undefined && !entry['input-regex']) throw new Error('input-regex must not be empty');
    if (entry.kind === 'tool' && entry.unconditional !== 'true' && !entry['input-regex']) throw new Error('tool trigger requires unconditional: true or input-regex');
    if (entry['before-first-act'] && !['true', 'false'].includes(entry['before-first-act'])) throw new Error('before-first-act must be true or false');
    // `mentions: true` — a `bash` trigger that also fires when a read-only command (grep, cat, echo…) only mentions
    // its match; by default such a mention is blanked before the regex runs (hooks/bash-mention.js).
    if (entry.mentions && !['true', 'false'].includes(entry.mentions)) throw new Error('mentions must be true or false');
    if (entry.mentions && entry.kind !== 'bash') throw new Error('mentions applies to bash triggers only');
    if (entry['command-head'] && !['true', 'false'].includes(entry['command-head'])) throw new Error('command-head must be true or false');
    if (entry['command-head'] && entry.kind !== 'bash') throw new Error('command-head applies to bash triggers only');
    return {
      kind: entry.kind,
       regex: entry.regex ? safeRegex(name, entry.regex, flags) : null,
       tool: entry.tool ? safeRegex(name, entry.tool) : null,
       input: entry['input-regex'] ? safeRegex(name, entry['input-regex'], flags) : null,
      beforeFirstAct: entry['before-first-act'] === 'true',
       onMention: entry.mentions === 'true',
       commandHead: entry['command-head'] === 'true',
    };
  });
  return { name, content: text.slice(match[0].length), triggers, compliance: parseCompliance(lines, complianceAt, name),
    ...(rawTriggers ? { rawTriggers: records } : {}) };
}
