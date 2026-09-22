// Bounded streaming defense for visible assistant text and best-effort tool-input JSON.
import { scrub } from './scrub.js';

const HOLD = 2048;
const MAX_BUFFER = 65536;
const PRIVATE_KEY_START = '-----BEGIN ';

function cleanText(text) { return scrub(text, '').value; }
function cleanInput(json) {
  try { return JSON.stringify(scrub(JSON.parse(json), '').value); } catch { return json; }
}

export async function* maskTurnStep(event, next, note, masked) {
  const buffers = new Map();
  let noted = false;
  let journaled = false;
  const flush = async function* (key) {
    const buffered = buffers.get(key);
    if (!buffered) return;
    buffers.delete(key);
    const field = buffered.kind === 'input' ? 'json' : 'text';
    const cleaned = buffered.kind === 'input' ? cleanInput(buffered.value) : cleanText(buffered.value);
    const changed = cleaned !== buffered.value;
    let value = cleaned;
    if (changed && buffered.kind === 'text' && !noted) { value = `${value}\n${note}`; noted = true; }
    if (changed && !journaled) { journaled = true; await masked(); }
    yield { ...buffered.chunk, [field]: value };
  };
  const flushAll = async function* () {
    for (const key of [...buffers.keys()]) yield* flush(key);
  };

  const iterator = next(event)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        yield* flushAll();
        const cleaned = scrub(step.value, '');
        if (cleaned.changed && !journaled) await masked();
        return cleaned.value;
      }
      const chunk = step.value;
      if (chunk.kind !== 'text' && chunk.kind !== 'input') {
        yield* flushAll();
        yield chunk;
        continue;
      }
      const field = chunk.kind === 'input' ? 'json' : 'text';
      const key = `${chunk.kind}:${chunk.index}`;
      for (const other of [...buffers.keys()]) if (other !== key) yield* flush(other);
      const value = `${buffers.get(key)?.value ?? ''}${chunk[field] ?? ''}`;
      buffers.set(key, { kind: chunk.kind, chunk, value });
      if (value.length > MAX_BUFFER) {
        buffers.set(key, { kind: chunk.kind, chunk, value: '[wt-secret-guard: oversized secret-bearing stream block masked]' });
        if (!journaled) { journaled = true; await masked(); }
        yield* flush(key);
        continue;
      }
      if (value.length > HOLD * 2 && !value.includes(PRIVATE_KEY_START)) {
        const cleaned = chunk.kind === 'input' ? cleanInput(value) : cleanText(value);
        if (cleaned !== value) yield* flush(key);
        else {
          const prefix = value.slice(0, -HOLD);
          buffers.set(key, { kind: chunk.kind, chunk, value: value.slice(-HOLD) });
          yield { ...chunk, [field]: prefix };
        }
      }
    }
  } finally {
    yield* flushAll();
  }
}

export async function maskAssistantRender(event, next) {
  const text = event.props?.text;
  if (typeof text !== 'string') return next(event);
  const cleaned = cleanText(text);
  return next(cleaned === text ? event : { ...event, props: { ...event.props, text: cleaned } });
}
