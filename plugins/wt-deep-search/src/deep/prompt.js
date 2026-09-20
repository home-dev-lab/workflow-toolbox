const MODES = new Set(['fast', 'instant', 'deep-lite', 'deep', 'deep-reasoning', 'agentic']);
const QUERY_FILLER = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'for', 'how', 'in', 'is', 'of', 'on', 'should', 'the',
  'their', 'to', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'would',
]);

function keywordQuery(question) {
  const words = question.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [];
  const useful = words.filter((word) => !QUERY_FILLER.has(word));
  return (useful.length > 0 ? useful : words).slice(0, 12).join(' ');
}

export function buildDeepPrompt({ mode, question }) {
  if (!MODES.has(mode)) throw new Error(`Unknown deep-search mode: ${mode}`);
  if (typeof question !== 'string' || !question.trim()) {
    throw new TypeError('Deep-search question must be a non-empty string');
  }

  const cleanQuestion = question.trim();
  if (mode === 'fast' || mode === 'instant') return keywordQuery(cleanQuestion);
  if (mode !== 'agentic') return cleanQuestion;

  return [
    'Research objective:',
    cleanQuestion,
    '',
    'Research this question thoroughly using current, primary sources where possible.',
    'Write a clear answer with an inline citation immediately after every factual assertion.',
    'Include source dates and state explicitly what could not be verified.',
  ].join('\n');
}
