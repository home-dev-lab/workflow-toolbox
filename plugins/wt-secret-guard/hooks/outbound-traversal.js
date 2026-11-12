// One lazy, parent-linked walk per classification. Exhaustion is evidence, never acceptance.
export const INSPECTION_NODES = 1000000;
export const INSPECTION_TEXT = 64 * 1024 * 1024;
export const TRUNCATED_PATH = Symbol('truncated path');
const ownConcealed = (value) => !Array.isArray(value) && Object.hasOwn(value, 'type')
  && value.type === 'CONCEALED' && Object.hasOwn(value, 'value') && typeof value.value === 'string';

function scalarUnit(value, key, pathRef) {
  if (typeof value === 'string') return { kind: 'value', text: value, key, pathRef };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'number', text: String(value), number: value, key, pathRef };
  return null;
}

function frame(value, pathRef) {
  return { value, pathRef, keys: Object.keys(value), cursor: 0, array: Array.isArray(value) };
}

function* enterChild(stack, child, name, ref) {
  const unit = scalarUnit(child, name, ref);
  if (unit) yield unit;
  if (!child || typeof child !== 'object') return;
  if (ownConcealed(child)) yield { kind: 'concealed', text: child.value, key: name, pathRef: ref };
  stack.push(frame(child, ref));
}

function* children(value, key, pathRef) {
  const scalar = scalarUnit(value, key, pathRef);
  if (scalar) yield scalar;
  if (!value || typeof value !== 'object') return;
  if (ownConcealed(value)) yield { kind: 'concealed', text: value.value, key, pathRef };
  const stack = [frame(value, pathRef)];
  while (stack.length) {
    const top = stack.at(-1);
    if (top.cursor === top.keys.length) { stack.pop(); continue; }
    const name = top.keys[top.cursor++];
    const ref = { key: name, parent: top.pathRef };
    yield { kind: 'node', text: '', key: name, pathRef: ref };
    if (!top.array) yield { kind: 'key', text: name, key: '', pathRef: ref };
    const child = top.value[name];
    yield* enterChild(stack, child, name, ref);
  }
}

export const inspectionBudget = () => ({ nodes: 0, text: 0, exhausted: false });

export function* walkOutbound(value, budget = inspectionBudget()) {
  budget.nodes += 1;
  for (const unit of children(value, '', null)) {
    if (unit.kind === 'node') budget.nodes += 1;
    else if (unit.kind !== 'concealed') budget.text += unit.text.length;
    const projectedText = unit.kind === 'concealed' ? budget.text + unit.text.length : budget.text;
    if (budget.exhausted || budget.nodes > INSPECTION_NODES || projectedText > INSPECTION_TEXT) {
      budget.exhausted = true;
      yield { kind: 'inspection-budget', text: '', key: '', pathRef: null };
      return;
    }
    if (unit.kind !== 'node') yield unit;
  }
}

export function materializePath(ref, limit = Infinity) {
  const parts = [];
  while (ref && parts.length < limit) { parts.push(ref.key); ref = ref.parent; }
  if (ref) parts.push(TRUNCATED_PATH);
  return parts.reverse();
}
