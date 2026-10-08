import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { renderPane, registerWithLayout, WORKFLOW_TOOLBOX_LAYOUT } from '../../../../../../plugin/hooks/hooks.js';
import { cellWidth } from '../../../../../../plugin/hooks/pane-design.js';

const component = (name) => (props = {}) => ({ name, props });
const ui = Object.fromEntries(['Box', 'Text', 'Button', 'Link', 'Client'].map((name) => [name, component(name)]));
const clientButton = (elements, key, label, fg, bg) => elements.Client({ key, module: './inverse-button.ts', props: { label, fg, bg } });
const rows = ['pilot', 'external'].flatMap((kind) => ['running', 'failed', 'done'].map((outcome, index) => ({
  id: `${kind}:${outcome}`, kind, project: 'demo', label: index ? 'Short worker' : 'A worker with a deliberately long descriptive label '.repeat(4).trim(),
  title: `Task ${outcome}`, phase: 'discovery', phaseStates: { discovery: 'running' },
  inspectors: { discovery: { summary: 'Evidence recorded.', href: 'https://example.test/report' } },
  cardUrl: 'https://example.test/card', elapsed: `${index + 1} min`, outcome,
})));
const snapshot = {
  discovery: 'partial', collectedAt: '2026-10-04T12:34:00Z', rows,
  pathRefusals: ['A source is unreadable'], refreshFailure: { detail: 'Collection failed', journalPath: 'journal.jsonl' },
  services: { count: 1, items: [{ label: 'Service worker', age: '2 min' }] },
  helpers: { count: 1, oldest: '3 min', items: [{ label: 'Helper worker', age: '3 min' }] },
};
const sessionSnapshot = { ...snapshot, rows: [], sessions: [{
  id: 'session:demo', project: 'demo', name: 'Demo session', actors: rows,
  cards: [
    { id: 'card-one', title: 'A bounded card title', cardUrl: 'https://example.test/card', actors: [{ ...rows[0], id: 'sdk-pilot', label: 'SDK pilot', sdkLifecycle: true,
      phase: 'critic', phaseStates: { discovery: 'done', plan: 'done', critic: 'running' }, phaseElapsed: { discovery: '2 min', plan: '11 min', critic: '8 min' },
      phaseCosts: { discovery: 'unknown' }, lanes: [{ ...rows[3], id: 'nested-lane', label: 'A sibling lane' }] }] },
    { id: 'card-two', title: 'Legacy stages', cardUrl: 'https://example.test/card', actors: [], devCycle: { stages: [
      { id: 'implementation', state: 'done', summary: 'Implementation recorded.' },
      { id: 'review', state: 'running', summary: 'Review recorded.' },
    ] } },
  ],
}] };
const expanded = new Set([...rows.map((row) => row.id), 'sdk-pilot', 'services', 'idle-helpers', 'discovery-detail', 'collector-failure']);
const selected = new Map([...rows.filter((row) => row.kind === 'pilot').map((row) => [row.id, 'discovery']), ['timeline:session:demo:card-one', 'discovery']]);
function render(width = 135, elements = ui, extra = {}, source = snapshot) {
  return renderPane(elements, source, expanded, selected, 'demo', true, {
    toggle() {}, select() {}, closeView() {}, switchScope() {}, close() {},
    bodyColumns: width, now: Date.parse('2026-10-04T12:34:10Z'), clientButton, ...extra,
  });
}
const children = (tree) => [tree?.props?.children ?? []].flat().filter((child) => child && typeof child === 'object');
function descendants(tree) { return [tree, ...children(tree).flatMap(descendants)]; }
function label(tree) {
  if (tree.name === 'Client') return tree.props.props.label;
  if (tree.name === 'Link') return tree.props.label;
  return [tree.props?.children ?? []].flat().filter((child) => typeof child === 'string').join('');
}
function text(tree) { return descendants(tree).map(label).filter(Boolean).join(' '); }
function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i, `Explicit hex colour required: ${hex}`);
  const values = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
export function contrast(fg, bg) {
  const pair = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (pair[0] + 0.05) / (pair[1] + 0.05);
}
function contrastTree(tree, fg = '#d7d7d7', bg = '#1e1e1e') {
  const props = tree.props || {};
  const foreground = props.color || fg;
  const background = props.backgroundColor || bg;
  if (background !== bg) assert.ok(contrast(background, bg) >= 3, `Neighbouring surface contrast below 3:1: ${background} / ${bg}`);
  if (['Text', 'Button'].includes(tree.name)) {
    assert.equal(Boolean(props.dimColor), false, `Unmeasured terminal dimming: ${label(tree)}`);
    assert.ok(contrast(foreground, background) >= 4.5, `${label(tree)} contrast below 4.5:1`);
    if (props.hover) assert.ok(contrast(props.hover.color || foreground, props.hover.backgroundColor || background) >= 4.5, `Hover contrast below 4.5:1: ${label(tree)}`);
    if (props.color === '#ffffff') {
      assert.equal(props.bold, true, 'Errors must remain bold');
      assert.match(label(tree), /⚠/, 'Errors must keep the warning glyph');
    }
    if (/\bERROR\b/.test(label(tree))) {
      assert.equal(props.bold, true, 'Error state words must be bold');
      assert.match(label(tree), /⚠/, 'Error state words must carry the warning glyph');
    }
  }
  if (tree.name === 'Client') {
    assert.ok(contrast(props.props.fg, props.props.bg) >= 4.5, `Button ${props.key} contrast below 4.5:1`);
    if (props.props.bg !== background) assert.ok(contrast(props.props.bg, background) >= 3, `Button ${props.key} surface contrast below 3:1`);
    assert.ok(contrast(props.props.fg, background) >= 3, `Pressed button ${props.key} surface contrast below 3:1`);
  }
  children(tree).forEach((child) => contrastTree(child, foreground, background));
}

// Small deterministic flex/word-wrap renderer: fixed children remain atomic, rows wrap
// between children, explicit widths constrain text. This checks the returned layout,
// rather than checking a list of intended strings or the implementation's constants.
function wrap(value, width) {
  return String(value).split('\n').flatMap((paragraph) => {
    const lines = [''];
    for (const word of paragraph.match(/\S+\s*/g) || []) {
      const last = lines.length - 1;
      if (lines[last] && lines[last].length + word.trimEnd().length > width) lines.push(word);
      else lines[last] += word;
    }
    return lines.map((line) => line.trimEnd());
  });
}
function layout(tree, width, indent = 0) {
  const props = tree.props || {};
  const localIndent = Number(props.paddingLeft) || 0;
  const right = Number(props.paddingRight) || 0;
  const available = Math.max(1, Math.min(Number(props.width) || width, width) - localIndent - right);
  if (['Text', 'Button', 'Link', 'Client'].includes(tree.name)) {
    const value = label(tree);
    const lines = tree.name === 'Button' ? value.split('\n') : wrap(value, available);
    return { lines, positions: [{ key: props.key, label: value, column: indent }], width: Math.max(0, ...lines.map((line) => line.length)) };
  }
  const parts = children(tree).map((child) => layout(child, available, indent + localIndent));
  if (props.flexDirection !== 'row') {
    const lines = parts.flatMap((part) => part.lines.map((line) => ' '.repeat(localIndent) + line));
    return { lines, positions: parts.flatMap((part) => part.positions), width: Number(props.width) || right + Math.max(0, ...lines.map((line) => line.length)) };
  }
  const lines = [''];
  const positions = [];
  let cursor = 0;
  let occupied = 0;
  let row = 0;
  for (const part of parts) {
    if (!part.lines.length) continue;
    const gap = cursor ? Number(props.columnGap) || 0 : 0;
    if (props.flexWrap === 'wrap' && cursor && cursor + gap + part.width > available) { row = lines.length; cursor = 0; lines.push(''); }
    const start = cursor + (cursor ? gap : 0);
    part.lines.forEach((line, index) => {
      while (lines.length <= row + index) lines.push('');
      lines[row + index] = lines[row + index].padEnd(start) + line;
    });
    positions.push(...part.positions.map((position) => ({ ...position, column: position.column + start })));
    cursor = start + part.width;
    occupied = Math.max(occupied, cursor);
  }
  return { lines: lines.map((line) => ' '.repeat(localIndent) + line), positions, width: Number(props.width) || localIndent + right + Math.max(occupied, ...lines.map((line) => line.length)) };
}

async function harness(withClient = true) {
  const hooks = [];
  let invalidations = 0;
  let opens = 0;
  let closes = 0;
  let failText = false;
  let failResolve = false;
  const elements = { ...ui, Text: (props) => {
    if (failText) { failText = false; throw new Error('draw failure'); }
    return ui.Text(props);
  }, ...(withClient ? {} : { Client: undefined }) };
  const $ = {
    env: { get: async () => undefined }, process: { run: async () => ({ exitCode: 0, stdout: JSON.stringify(snapshot) }) },
    command: { register: async () => {} }, clock: { every: () => ({ cancel() {} }) },
    ui: { resolve: async () => { if (failResolve) throw new Error('resolve failure'); return elements }, invalidate: () => { invalidations += 1 }, log: async () => {},
      open: async () => { opens += 1 }, close: async () => { closes += 1 } },
  };
  registerWithLayout((event, matcher, hook) => hooks.push({ event, matcher: hook ? matcher : {}, hook: hook || matcher }), {}, WORKFLOW_TOOLBOX_LAYOUT, clientButton);
  const call = (event, data) => hooks.find((entry) => entry.event === event && (!data.component || entry.matcher.component === data.component))?.hook($, data, async () => null);
  await call('session.start', { cwd: '/workspace/demo' });
  await call('command.run', { command: 'wir' });
  return { hooks, call, elements, rejectResolve: () => { failResolve = true }, failNextRender: () => { failText = true }, pane: () => call('ui.render', { component: 'Pane', requestId: 'wt-what-is-running', props: { bodyColumns: 66 } }), counts: () => ({ invalidations, opens, closes }) };
}

// Independent cell oracle for the fixture alphabet, not the production width helper.
function fixtureCells(value) {
  return [...value].reduce((total, char) => total + (/\p{Mark}/u.test(char) ? 0 : /[界😀]/u.test(char) ? 2 : 1), 0);
}
function explicitTextContrast(tree, bg = '#ffffff') {
  const background = tree.props?.backgroundColor || bg;
  if (tree.name === 'Text') {
    assert.ok(tree.props.color, `Text needs an explicit foreground: ${label(tree)}`);
    assert.ok(contrast(tree.props.color, background) >= 4.5, `Text contrast below 4.5:1 on its actual background: ${label(tree)}`);
  }
  children(tree).forEach((child) => explicitTextContrast(child, background));
}

export const locks = [
  ['render exits discard pane and hint handlers before resolve and capability checks', async () => {
    for (const component of ['Pane', 'PromptHint']) {
      for (const exit of ['reject', 'capability']) {
        const h = await harness();
        const draw = () => component === 'Pane' ? h.pane() : h.call('ui.render', { component });
        const tree = await draw();
        const old = descendants(tree).find((item) => item.name === 'Client' && (component === 'PromptHint' || label(item).includes('Services')));
        assert.ok(old);
        if (exit === 'reject') h.rejectResolve();
        else h.elements.Box = undefined;
        assert.equal(await draw(), null);
        const before = h.counts();
        await h.call('ui.message', { element: old.props.key, data: { pressed: true } });
        assert.deepEqual(h.counts(), before, `${component} ${exit} render must discard old handlers`);
      }
    }
  }],
  ['delayed pane A presses cannot act on replacement pane B', async () => {
    const h = await harness();
    const hintKey = descendants(await h.call('ui.render', { component: 'PromptHint' })).find((item) => item.name === 'Client').props.key;
    const a = descendants(await h.pane()).filter((item) => item.name === 'Client');
    const closeA = a.find((item) => label(item) === 'Close');
    await h.call('ui.message', { element: closeA.props.key, data: { pressed: true } });
    await h.call('ui.message', { element: hintKey, data: { pressed: true } });
    const b = descendants(await h.pane()).filter((item) => item.name === 'Client');
    const before = h.counts();
    await h.call('ui.message', { element: closeA.props.key, data: { pressed: true } });
    assert.deepEqual(h.counts(), before, 'Delayed pane A Close must not close pane B');
    for (const old of a) await h.call('ui.message', { element: old.props.key, data: { pressed: true } });
    assert.deepEqual(h.counts(), before, 'No delayed pane A control may act on pane B');
    assert.equal(descendants(await h.call('ui.render', { component: 'PromptHint' })).find((item) => item.name === 'Client').props.key, hintKey, 'PromptHint opener key stays stable');
    const closeB = b.find((item) => label(item) === 'Close');
    await h.call('ui.message', { element: closeB.props.key, data: { pressed: true } });
    assert.equal(h.counts().closes, before.closes + 1, 'Current pane B Close remains operable');
  }],
  ['Unicode Client labels fit their allocated terminal cells and rows', () => {
    for (const width of [40, 66, 135]) {
      for (const value of ['界'.repeat(20), '😀'.repeat(20), 'e\u0301'.repeat(20), '界 😀 e\u0301 '.repeat(8).trim()]) {
        const source = { discovery: 'available', rows: [{ id: 'unicode', kind: 'external', project: 'demo', label: value, outcome: 'running' }] };
        const tree = render(width, ui, {}, source);
        const wrapper = descendants(tree).find((item) => item.props?.key === 'control:detail-toggle:row:unicode');
        const button = descendants(wrapper).find((item) => item.name === 'Client');
        const available = wrapper.props.width - wrapper.props.paddingLeft - wrapper.props.paddingRight;
        const lines = [''];
        for (const word of label(button).split(/\s+/)) {
          const last = lines.length - 1;
          if (lines[last] && fixtureCells(`${lines[last]} ${word}`) > available) lines.push(word);
          else lines[last] += `${lines[last] ? ' ' : ''}${word}`;
        }
        assert.ok(lines.every((line) => fixtureCells(line) <= available), `Unicode label exceeds its ${available}-cell surface at ${width} columns: ${label(button)}`);
        assert.ok(wrapper.props.height >= lines.length, 'Wrapper must allocate every label row');
        assert.ok(wrapper.props.width <= width, 'Unicode wrapper must fit the pane');
      }
    }
    const accent = render(40, ui, {}, { discovery: 'available', rows: [{ id: 'unicode', kind: 'external', project: 'demo', label: 'e\u0301'.repeat(20), outcome: 'running' }] });
    assert.ok(text(accent).includes('e\u0301'.repeat(20)), 'Zero-cell combining marks must not cause unnecessary elision');
  }],
  ['an open and a closed toggle occupy the same width, so the row does not shift on a click', () => {
    // A terminal draws text-presentation pictographs such as ▶ in ONE cell; only emoji presentation is wide.
    const source = { discovery: 'available', rows: [{ id: 'same', kind: 'external', project: 'demo', label: 'Services (2)', outcome: 'running' }] };
    const wrapperWidth = (open) => {
      const tree = renderPane(ui, source, new Set(open ? ['same'] : []), new Map(), 'demo', true, {
        toggle() {}, select() {}, closeView() {}, switchScope() {}, close() {}, bodyColumns: 135, now: Date.parse('2026-10-04T12:34:10Z'), clientButton,
      });
      return descendants(tree).find((item) => item.props?.key === 'control:detail-toggle:row:same').props.width;
    };
    assert.equal(wrapperWidth(false), wrapperWidth(true), 'Closed (▶) and open (▼) toggles must reserve the same cells');
    assert.equal(wrapperWidth(false), 'x Services (2)'.length + 2, 'A text-presentation ▶ counts one cell');
    assert.equal(cellWidth('▶ ▼ © ✕'), 7, 'Text-presentation symbols are one cell each');
    assert.equal(cellWidth('😀\u2764\uFE0F'), 4, 'Emoji presentation, and a pictograph forced to emoji by VS16, are two cells');
  }],
  ['normal and failure panes paint explicit contrasting text on their own background', async () => {
    for (const elements of [ui, { ...ui, Client: undefined }]) {
      explicitTextContrast(render(40, elements));
      explicitTextContrast(render(135, elements, {}, sessionSnapshot));
    }
    const h = await harness();
    h.failNextRender();
    const failure = await h.pane();
    assert.equal(failure.props.backgroundColor, '#1e1e1e', 'Failure pane must paint its own dark background');
    explicitTextContrast(failure);
  }],
  ['only pressed true messages invoke pane or hint actions', async () => {
    const h = await harness();
    const close = descendants(await h.pane()).find((item) => item.name === 'Client' && label(item) === 'Close');
    const hint = descendants(await h.call('ui.render', { component: 'PromptHint' })).find((item) => item.name === 'Client');
    const before = h.counts();
    for (const button of [close, hint]) {
      for (const message of [{ pressed: false }, {}, { pressed: 1 }, undefined]) {
        await h.call('ui.message', { element: button.props.key, data: message, message: { pressed: true } });
        assert.deepEqual(h.counts(), before, 'Non-press messages must not invoke actions');
      }
    }
    await h.call('ui.message', { element: close.props.key, data: { pressed: true } });
    assert.equal(h.counts().closes, before.closes + 1);
  }],
  ['fitting unbroken project and model names keep their available width', () => {
    for (const width of [40, 66, 135]) {
      const project = 'abcdefghijklmnopqrstuvwxyz123456' + 'x'.repeat(width === 40 ? 0 : width === 66 ? 26 : 74);
      const scope = width < 72 ? `· ${project}` : `Scope: this project · ${project}`;
      const tree = renderPane(ui, { discovery: 'available', rows: [] }, new Set(), new Map(), project, false, {
        bodyColumns: width, clientButton, toggle() {}, select() {}, closeView() {}, switchScope() {}, close() {},
      });
      const model = 'm'.repeat(width - 8);
      const modelTree = render(width, ui, {}, { discovery: 'available', rows: [{ ...rows[3], label: 'Worker', showModel: true, model }] });
      for (const [source, value] of [[tree, scope], [modelTree, `· ${model}`]]) {
        const parent = descendants(source).find((item) => children(item).some((child) => child.name === 'Text' && label(child) === value));
        assert.ok(parent, `Missing fitting text: ${value}`);
        assert.ok(parent.props.width >= value.length, `Fitting text must not be capped below ${value.length} cells at ${width} columns (got ${parent.props.width})`);
        assert.ok(layout(source, width).lines.some((line) => line.includes(value)), 'Fitting text must stay intact in the returned layout');
      }
    }
  }],
  ['contrast on every rendered text and control', () => {
    for (const tree of [render(), render(66, { ...ui, Client: undefined }), render(40, ui, {}, sessionSnapshot)]) {
      for (const item of descendants(tree)) {
        for (const value of [item.props?.color, item.props?.backgroundColor].filter(Boolean)) luminance(value);
      }
      contrastTree(tree);
      assert.ok(descendants(tree).some((item) => item.name === 'Link'), 'Existing links must stay links');
    }
  }],
  ['every coloured row kind has a non-hue identifier', () => {
    for (const source of [snapshot, sessionSnapshot]) {
      const tree = render(135, ui, {}, source);
      for (const row of rows) {
        const branch = descendants(tree).find((item) => item.props?.key === (row.kind === 'pilot' ? `pilot:${row.id}` : row.id));
        assert.ok(branch, `Missing row kind ${row.kind}`);
        const colours = descendants(branch).filter((item) => item.name === 'Text' && item.props.color).map((item) => item.props.color);
        if (colours.length) assert.match(text(branch), new RegExp(`\\b${row.kind}\\b`, 'i'), `Coloured ${row.kind} row needs a kind identifier`);
      }
      for (const [kind, group] of Object.entries(source).filter(([, value]) => value && Array.isArray(value.items))) {
        assert.ok(group.count > 0);
        const branch = descendants(tree).find((item) => item.props?.key === kind || item.props?.key?.endsWith(`-${kind}`));
        assert.ok(branch, `Missing process row kind ${kind}`);
        assert.match(text(branch), new RegExp(`\\b${kind}\\b`, 'i'), `Coloured ${kind} group needs a kind identifier`);
      }
    }
  }],
  ...[135, 66, 40].map((width) => [`width invariants at ${width} columns`, () => {
    for (const elements of [ui, { ...ui, Client: undefined }]) {
      for (const source of [snapshot, sessionSnapshot]) {
        const tree = render(width, elements, {}, source);
        const rendered = layout(tree, width);
        for (const line of rendered.lines) {
          assert.ok(line.length <= width, `Overflow at ${width}: ${line}`);
          assert.doesNotMatch(line.trim(), /^│|│$/, `Orphan separator at ${width}: ${line}`);
        }
        for (const button of descendants(tree).filter((item) => ['Button', 'Client'].includes(item.name))) {
          for (const word of label(button).split(/\s+/).filter(Boolean)) assert.ok(rendered.lines.some((line) => line.includes(word)), `Button word cut: ${word}`);
        }
        for (const kind of new Set(rows.map((row) => row.kind))) {
          const columns = rows.filter((row) => row.kind === kind).map((row) => rendered.positions.find((position) => position.key === `wirbtn-detail-toggle:row:${row.id}` || position.key === `detail-toggle:row:${row.id}`)?.column);
          assert.ok(columns.every(Number.isFinite), `Missing ${kind} row positions`);
          assert.equal(new Set(columns).size, 1, `Sibling ${kind} rows have differing indents`);
        }
        if (source.sessions) {
          const stage = rendered.positions.find((position) => ['wirbtn-detail-toggle:stage:session:demo:card-one:discovery', 'detail-toggle:stage:session:demo:card-one:discovery'].includes(position.key));
          const detail = rendered.positions.find((position) => position.label === 'Discovery');
          assert.ok(detail.column > stage.column, 'Expanded stage detail must remain indented beyond its button label');
        }
      }
    }
  }]),
  ['every control uses a unique Client and routes only its own press', async () => {
    const buttonHandlers = new Map();
    const calls = [];
    const actions = Object.fromEntries(['toggle', 'select', 'closeView', 'switchScope', 'close'].map((name) => [name, (...args) => calls.push([name, ...args])]));
    for (const source of [snapshot, sessionSnapshot, { ...snapshot, discovery: 'unknown' }]) {
      buttonHandlers.clear();
      const all = descendants(render(66, ui, { ...actions, buttonHandlers }, source)).filter((item) => item.name === 'Client');
      const fallback = descendants(render(66, { ...ui, Client: undefined }, {}, source)).filter((item) => item.name === 'Button');
      assert.equal(all.length, fallback.length, 'Every expanded control must use the Client route');
      assert.equal(buttonHandlers.size, all.length, 'Expanded Client keys must be unique');
      for (const button of all) {
        assert.equal(button.props.module, './inverse-button.ts');
        const before = calls.length;
        buttonHandlers.get(button.props.key)();
        assert.equal(calls.length, before + 1, `Unrouted control ${button.props.key}`);
      }
    }
    const dirtyId = 'dirty\x1b[31m\t';
    buttonHandlers.clear();
    const dirtyTree = render(66, ui, { ...actions, buttonHandlers }, { ...snapshot, rows: [
      { ...rows[0], id: dirtyId, label: 'Dirty worker' },
      { ...rows[0], id: 'dirty ', label: 'Clean worker' },
    ] });
    const dirtyClients = descendants(dirtyTree).filter((item) => item.name === 'Client');
    assert.equal(new Set(dirtyClients.map((item) => item.props.key)).size, dirtyClients.length, 'Different raw IDs must retain unique printable Client keys');
    const dirtyClient = descendants(dirtyTree).find((item) => item.name === 'Client' && item.props.props.label.includes('Dirty worker'));
    assert.ok(buttonHandlers.has(dirtyClient.props.key), 'Sanitizing the rendered tree must not detach a Client key from its callback');
    buttonHandlers.get(dirtyClient.props.key)();
    assert.deepEqual(calls.at(-1), ['toggle', dirtyId]);
    const h = await harness();
    const tree = await h.pane();
    const clients = descendants(tree).filter((item) => item.name === 'Client');
    assert.ok(clients.length > 0, 'Every control must render a Client when ui.Client exists');
    assert.equal(descendants(tree).filter((item) => item.name === 'Button').length, 0);
    assert.equal(new Set(clients.map((item) => item.props.key)).size, clients.length);
    clients.forEach((item) => assert.equal(item.props.module, './inverse-button.ts'));
    assert.ok(descendants(render(66, { ...ui, Client: undefined })).filter((item) => item.name === 'Button').length >= clients.length);
    assert.equal(h.hooks.filter((hook) => hook.event === 'ui.message').length, 1);
    const services = clients.find((item) => item.props.props.label.includes('Services'));
    const before = h.counts().invalidations;
    await h.call('ui.message', { element: 'another-client', data: { pressed: true } });
    assert.equal(h.counts().invalidations, before);
    await h.call('ui.message', { element: services.props.key, data: { pressed: true } });
    assert.equal(h.counts().invalidations, before + 1);
    assert.match(text(await h.pane()), /▼ Services/);
    assert.doesNotMatch(text(await h.pane()), /▼ Idle helpers/);
  }],
  ['PromptHint Client opens and failure/close controls remain operable', async () => {
    const h = await harness();
    const hint = await h.call('ui.render', { component: 'PromptHint' });
    const client = descendants(hint).find((item) => item.name === 'Client');
    assert.ok(client, 'PromptHint must use the inverse Client button');
    assert.equal(client.props.module, './inverse-button.ts');
    const before = h.counts().opens;
    await h.call('ui.message', { element: client.props.key, data: { pressed: true } });
    assert.equal(h.counts().opens, before + 1);
    const previousPane = await h.pane();
    const partialKey = descendants(previousPane).find((item) => item.name === 'Client' && label(item).includes('Services')).props.key;
    h.failNextRender();
    const failed = await h.pane();
    assert.match(text(failed), /display failed: draw failure/);
    const beforeFailurePress = h.counts().invalidations;
    await h.call('ui.message', { element: partialKey, data: { pressed: true } });
    assert.equal(h.counts().invalidations, beforeFailurePress, 'A failed render must discard partial Client callbacks');
    const close = descendants(failed).find((item) => item.name === 'Client' && label(item) === 'Close');
    assert.ok(close, 'Failure pane Close must use the Client route');
    await h.call('ui.message', { element: close.props.key, data: { pressed: true } });
    assert.equal(h.counts().closes, 1);
    await h.call('ui.message', { element: close.props.key, data: { pressed: true } });
    assert.equal(h.counts().closes, 1, 'Closed pane callbacks must be discarded');
    const old = await harness(false);
    assert.ok(descendants(await old.call('ui.render', { component: 'PromptHint' })).some((item) => item.name === 'Button'));
  }],
  ['header prints the snapshot clock moment exactly once', () => {
    const value = text(render());
    const date = new Date(snapshot.collectedAt);
    const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    assert.equal(value.split(clock).length - 1, 1, 'Snapshot HH:MM must appear exactly once');
    assert.doesNotMatch(value, /2026-10-04|12:34:00|T12:/);
  }],
  ['duration columns align within actor and stage groups', () => {
    for (const width of [135, 66, 40]) {
      const rendered = layout(render(width), width);
      const lines = rendered.lines.filter((line) => /external.*(?:running|done|ERROR).*\d min/.test(line));
      assert.equal(lines.length, rows.filter((row) => row.kind === 'external').length, `Missing external durations at ${width}`);
      assert.equal(new Set(lines.map((line) => line.search(/\d min/))).size, 1, `Duration columns differ at ${width}`);
      const stageDates = new Set(Object.values(sessionSnapshot.sessions[0].cards[0].actors[0].phaseElapsed).map((elapsed) => `· ${elapsed}`));
      const phaseColumns = layout(render(width, ui, {}, sessionSnapshot), width).positions.filter((position) => stageDates.has(position.label));
      assert.equal(phaseColumns.length, stageDates.size, 'Every reported stage duration must be rendered');
      assert.equal(new Set(phaseColumns.map((position) => position.column)).size, 1, `Stage duration columns differ at ${width}`);
    }
  }],
  ['host entry declares the literal JSX module and the hook stays plain Node', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../../../../plugin/hooks/hooks.json', import.meta.url), 'utf8'));
    assert.deepEqual(manifest.modules, ['./entry.tsx']);
    const entry = readFileSync(new URL('../../../../../../plugin/hooks/entry.tsx', import.meta.url), 'utf8');
    assert.match(entry, /<Client\s[^>]*module="\.\/inverse-button\.ts"/);
    assert.doesNotMatch(readFileSync(new URL('../../../../../../plugin/hooks/hooks.js', import.meta.url), 'utf8'), /import.*\.tsx/);
  }],
];

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let failed = 0;
  for (const [name, run] of locks) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}\n${error.stack}`); }
  }
  const controls = descendants(render()).filter((item) => ['Button', 'Client'].includes(item.name));
  console.log(`REPRESENTATIVE CONTROLS=${controls.length} CLIENTS=${controls.filter((item) => item.name === 'Client').length} BUTTONS=${controls.filter((item) => item.name === 'Button').length}`);
  console.log(`LOCKS=${locks.length} FAILED=${failed}`);
  process.exitCode = failed ? 1 : 0;
}
