// Bounded streaming defense for visible assistant text. Tool input stays raw for tool.call refusal.
import { scrub } from './scrub.js';
import { knownTokens } from './token-vault.js';

const MIN_HOLD = 512;
const MAX_BUFFER = 65536;
const PRIVATE_KEY_START = '-----BEGIN ';

function cleanText(text) { return scrub(text, '').value; }
function holdBack() { return Math.max(MIN_HOLD, ...[...knownTokens().values()].map(({ value }) => value.length)); }

export async function* maskTurnStep(event, next, note, masked) {
  const buffers = new Map();
  let noted = false;
  let journaled = false;
  const flush = async function* (key) {
    const buffered = buffers.get(key);
    if (!buffered) return;
    buffers.delete(key);
    const field = 'text';
    const cleaned = cleanText(buffered.value);
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
      if (chunk.kind !== 'text') {
        yield* flushAll();
        yield chunk;
        continue;
      }
      const field = 'text';
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
      const hold = holdBack();
      if (value.length > hold * 2 && !value.includes(PRIVATE_KEY_START)) {
        const prefix = value.slice(0, -hold);
        const tail = value.slice(-hold);
        const cleaned = cleanText(prefix);
        if (cleaned !== prefix) {
          buffers.set(key, { kind: chunk.kind, chunk, value: prefix });
          yield* flush(key);
        } else yield { ...chunk, [field]: prefix };
        buffers.set(key, { kind: chunk.kind, chunk, value: tail });
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
