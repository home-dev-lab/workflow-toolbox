const BUTTON_TEXT = '#111111';
const MAX_BUTTON_LABEL_COLUMNS = 48;
export const COLORS = Object.freeze({
  background: '#1e1e1e', text: '#d7d7d7', muted: '#b8b8b8',
  action: BUTTON_TEXT, actionOpen: BUTTON_TEXT, close: BUTTON_TEXT, link: '#e6e6e6',
  buttonText: BUTTON_TEXT, buttonSurface: '#e6e6e6', external: '#969696', error: '#ffffff',
});

const element = (Component, props, ...children) => Component(children.length ? { ...props, children: children.flat() } : props);
export function elementKey(value) {
  let key = '';
  for (const char of String(value)) {
    const code = char.charCodeAt(0);
    if (char === '%' || code <= 31 || (code >= 127 && code <= 159)) key += encodeURIComponent(char);
    else key += char;
  }
  return key;
}

export function textStyle(props) {
  const { dimColor, ...rest } = props;
  return { wrap: 'wrap', ...rest, color: props.color || (dimColor ? COLORS.muted : COLORS.text) };
}

const WIDE_CELL_RANGES = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff01, 0xff60],
  [0xffe0, 0xffe6], [0x16fe0, 0x18dff], [0x1b000, 0x1b2ff], [0x20000, 0x3fffd],
];
const wideCell = (code) => code !== 0x303f && WIDE_CELL_RANGES.some(([low, high]) => code >= low && code <= high);

export function cellWidth(value) {
  let width = 0;
  const chars = [...String(value)];
  for (const [index, char] of chars.entries()) {
    const code = char.codePointAt(0);
    if (/\p{Mark}|\p{Format}/u.test(char) || code < 32 || (code >= 127 && code < 160)) continue;
    // A terminal draws a text-presentation pictograph (▶, ©) in one cell; it takes two only with emoji presentation,
    // either by default or when a VS16 selector follows it.
    const emoji = /\p{Emoji_Presentation}/u.test(char) || (/\p{Extended_Pictographic}/u.test(char) && chars[index + 1] === '️');
    width += wideCell(code) || emoji ? 2 : 1;
  }
  return width;
}

// An unreported width is treated as wide, as the header layout does (`narrow` needs a reported width below 72):
// shortening labels for a width nobody measured would hide text on hosts that simply do not report one.
export const UNREPORTED_PANE_COLUMNS = 160;
export function paneColumns(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return UNREPORTED_PANE_COLUMNS;
  return Number(value) >= 40 ? Math.floor(Number(value)) : 40;
}

export function stateWords(state) {
  return state.words === 'ERROR' ? '⚠ ERROR' : state.words;
}

export function stageColumns(stages, elapsed) {
  const times = stages.map((stage) => {
    const value = elapsed?.[stage.id];
    return value && value !== 'unknown' ? cellWidth(value) + 2 : 0;
  });
  return {
    name: MAX_BUTTON_LABEL_COLUMNS + 2,
    state: Math.max(1, ...stages.map((stage) => cellWidth(stateWords(stage.state)))),
    time: Math.max(0, ...times),
  };
}

function elidedWord(token) {
  const left = token.startsWith('[') ? '[' : '';
  const right = token.endsWith(']') ? ']' : '';
  return `${left}…${right}`;
}

function wrappedLabel(label, limit) {
  const lines = [''];
  for (const token of label.split(/\s+/)) {
    const word = cellWidth(token) > limit ? elidedWord(token) : token;
    const index = lines.length - 1;
    if (lines[index] && cellWidth(lines[index]) + cellWidth(word) + 1 > limit) lines.push(word);
    else lines[index] += `${lines[index] ? ' ' : ''}${word}`;
  }
  return { label: lines.join(' '), width: Math.max(...lines.map(cellWidth)), height: lines.length };
}

function fallbackLabel(label, limit) {
  const full = `[${label}]`;
  if (cellWidth(full) <= limit) return { label: full, width: cellWidth(full), height: 1 };
  const words = [];
  for (const word of label.split(/\s+/)) {
    if (cellWidth(words.concat(word).join(' ')) > limit - 4) break;
    words.push(word);
  }
  const shown = words.length ? `[${words.join(' ')} …]` : '[…]';
  return { label: shown, width: cellWidth(shown), height: 1 };
}

export function drawControl(ui, props, label, actions = {}) {
  const columns = paneColumns(actions.bodyColumns);
  const useClient = Boolean(ui.Client && actions.clientButton);
  const limit = Math.min(MAX_BUTTON_LABEL_COLUMNS, columns - 12);
  const shown = useClient ? wrappedLabel(label, limit) : fallbackLabel(label, limit);
  const { width, height } = shown;
  let button;
  if (useClient) {
    const key = `wirbtn-${props.key}${actions.buttonGeneration === undefined ? '' : `:${actions.buttonGeneration}`}`;
    actions.buttonHandlers?.set(elementKey(key), props.onPress);
    button = actions.clientButton(ui, key, shown.label, COLORS.buttonText, COLORS.buttonSurface);
  } else {
    button = element(ui.Box, { flexShrink: 0, width, backgroundColor: COLORS.action },
      element(ui.Button, { ...props, hover: { color: COLORS.buttonText, backgroundColor: COLORS.buttonSurface, bold: true } }, shown.label));
  }
  // The light rim remains visible when the pressed surface turns dark.
  return element(ui.Box, { key: `control:${props.key}`, flexShrink: 0, width: width + 2,
    height, paddingLeft: 1, paddingRight: 1, backgroundColor: COLORS.buttonSurface }, button);
}

export function snapshotClock(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function evidenceLines(Text, summary) {
  const lines = String(summary || '').replace(/\r\n?/g, '\n').split('\n').map((raw) => {
    const trimmed = raw.trim();
    const heading = /^#{1,6}\s/.exec(trimmed);
    const content = heading ? trimmed.slice(heading[0].length).trim() : trimmed;
    const text = content.replace(/^[-*]\s+/, '').replace(/\*\*|__|`/g, '').trim();
    return text && !/^[A-Za-z][A-Za-z ]*:$/.test(text) ? { text, heading: Boolean(heading) } : null;
  }).filter(Boolean);
  const shown = [];
  let budget = 900;
  for (const line of lines.slice(0, 7)) {
    if (budget <= 0) break;
    const text = line.text.length > Math.min(240, budget) ? `${line.text.slice(0, Math.min(240, budget) - 1).trimEnd()}…` : line.text;
    budget -= text.length;
    shown.push(element(Text, { wrap: 'wrap', bold: line.heading }, text));
  }
  if (lines.length > shown.length) shown.push(element(Text, { dimColor: true }, `… ${lines.length - shown.length} more lines`));
  return shown;
}
