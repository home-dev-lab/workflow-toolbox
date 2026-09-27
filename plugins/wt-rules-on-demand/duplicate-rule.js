// Shared by the host hook and the Node startup command; no Node imports here.
export function ruleBody(text, onDemand = false) {
  let body = String(text).replace(/\r\n?/g, '\n');
  if (onDemand) body = body.replace(/^---\n[\s\S]*?\n---\n/, '');
  const lines = body.split('\n');
  if (lines[0]?.toLowerCase().startsWith('<!-- installed ' + 'from ') && lines[0].trimEnd().endsWith(' -->')) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.map((line) => line.trimEnd()).join('\n');
}

export const sameRule = (staticText, demandText) => ruleBody(staticText) === ruleBody(demandText, true);
