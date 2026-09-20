export function formatResult(record, { shape = record?.shape ?? 'prose' } = {}) {
  if (!record || record.status !== 'done') {
    throw new Error(`Deep-search run is ${record?.status ?? 'unknown'}, not done`);
  }
  if (shape === 'prose') {
    const content = record.result?.content ?? record.result;
    let prose = typeof content === 'string' ? content : content?.prose;
    if (typeof prose !== 'string' && Array.isArray(content?.claims)) {
      const claims = content.claims.map((item) => {
        const source = item.url ? ` [source](${item.url})` : '';
        const date = item.date ? ` (${item.date})` : '';
        return `${item.claim}${source}${date}`;
      });
      const unverified = (content.unverified ?? []).map((item) => `Could not verify: ${item}`);
      prose = [...claims, ...unverified].join('\n\n');
    }
    if (typeof prose !== 'string') throw new Error('Deep-search result has no prose answer');
    // The engine's `[1]` markers point at a SEPARATE grounding field; rendered apart from the
    // prose they resolve to nothing, which is a citation in appearance only.
    const citations = (record.result?.grounding ?? [])
      .flatMap((entry) => entry?.citations ?? [])
      .map((citation, index) => `[${index + 1}] ${citation.title ?? citation.url} — ${citation.url}`);
    const sources = citations.length > 0 ? `\n\nSources\n${citations.join('\n')}` : '';
    const cost = typeof record.result?.costDollars === 'number'
      ? ` — this run cost $${record.result.costDollars}`
      : '';
    return `Answered by ${record.engine}${cost}\n\n${prose}${sources}`;
  }
  if (shape === 'structured') {
    // The output schema is sent at START, so a run begun for prose never carried the claim schema
    // and has no claims to return. Stuffing its prose into `unverified` would look like an answer.
    if (record.shape === 'prose' && typeof (record.result?.content ?? record.result) === 'string') {
      throw new Error('This run was started for prose; start a new run with --shape structured to get claims');
    }
    const content = record.result?.content ?? record.result;
    const value = typeof content === 'object' && content !== null
      ? content
      : { claims: [], unverified: [String(content ?? '')] };
    return {
      engine: record.engine,
      costDollars: record.result?.costDollars ?? null,
      claims: Array.isArray(value.claims) ? value.claims : [],
      unverified: Array.isArray(value.unverified) ? value.unverified : [],
    };
  }
  throw new Error(`Unknown deep-search result shape: ${shape}`);
}
