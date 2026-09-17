export function stripAnsiAndControl(value) {
  const input = String(value);
  let output = '';
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    const next = input.charCodeAt(index + 1);
    const csi = code === 155 || (code === 27 && next === 91);
    const stringSequence = [144, 157, 158, 159].includes(code) || (code === 27 && [80, 93, 94, 95].includes(next));
    if (csi) {
      index += 1;
      if (code === 27) index += 1;
      while (index < input.length && (input.charCodeAt(index) < 64 || input.charCodeAt(index) > 126)) index += 1;
      continue;
    }
    if (stringSequence) {
      index += 1;
      if (code === 27) index += 1;
      while (index < input.length) {
        if (input.charCodeAt(index) === 7) break;
        if (input.charCodeAt(index) === 27 && input.charCodeAt(index + 1) === 92) { index += 1; break; }
        index += 1;
      }
      continue;
    }
    if (code === 27) {
      if (next >= 64 && next <= 95) index += 1;
      continue;
    }
    if (code <= 31 || (code >= 127 && code <= 159)) output += ' ';
    else output += input[index];
  }
  return output;
}
