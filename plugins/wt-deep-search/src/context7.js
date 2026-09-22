const CALL_TIMEOUT_MS = 8000
const TOTAL_TIMEOUT_MS = 18000

const LIBRARIES = [
  [/\bnext\.?js\b/i, 'Next.js'], [/\bReact Native\b/, 'React Native'], [/\bReact(?:\.js)?\b/, 'React'],
  [/\bvue(?:\.js)?\b/i, 'Vue'], [/\bsvelte(?:kit)?\b/i, 'Svelte'], [/\bAngular\b/, 'Angular'],
  [/\bExpress(?:\.js)?\b/, 'Express'], [/\bprisma\b/i, 'Prisma'], [/\btailwind(?:css)?\b/i, 'Tailwind CSS'],
  [/\bdjango\b/i, 'Django'], [/\bspring boot\b/i, 'Spring Boot'], [/\bfastapi\b/i, 'FastAPI'],
  [/\bflask\b/i, 'Flask'], [/\bruby on rails\b/i, 'Ruby on Rails'], [/\blaravel\b/i, 'Laravel'],
  [/\bnode\.js\b/i, 'Node.js'], [/\btypescript\b/i, 'TypeScript'], [/\bzod\b/i, 'Zod'],
  [/\bVite\b/, 'Vite'], [/\bwebpack\b/i, 'webpack'], [/\beslint\b/i, 'ESLint'],
  [/\bprettier\b/i, 'Prettier'], [/\bvitest\b/i, 'Vitest'], [/\bJest\b/, 'Jest'],
  [/\bplaywright\b/i, 'Playwright'], [/\bcypress\b/i, 'Cypress'], [/\bElectron\b/, 'Electron'],
  [/\bFlutter\b/, 'Flutter'], [/\bBun\b/, 'Bun'], [/\bdeno\b/i, 'Deno'],
  [/\bpnpm\b/i, 'pnpm'], [/\bnpm\b/i, 'npm'], [/\bYarn\b/, 'Yarn'],
  [/\bdocker\b/i, 'Docker'], [/\bkubernetes\b/i, 'Kubernetes'], [/\bterraform\b/i, 'Terraform'],
  [/\baws\b|\bamazon web services\b/i, 'AWS'], [/\bgoogle cloud\b|\bgcp\b/i, 'Google Cloud'],
  [/\bmicrosoft azure\b|\bazure\b/i, 'Microsoft Azure'], [/\bstripe\b/i, 'Stripe'],
  [/\bsupabase\b/i, 'Supabase'], [/\bfirebase\b/i, 'Firebase'], [/\bmongodb\b/i, 'MongoDB'],
  [/\bpostgres(?:ql)?\b/i, 'PostgreSQL'], [/\bredis\b/i, 'Redis'], [/\bgithub cli\b|\bgh cli\b/i, 'GitHub CLI'],
]

export function libraryFromQuestion(question) {
  const query = String(question ?? '')
  return LIBRARIES.find(([pattern]) => pattern.test(query))?.[1] ?? null
}

function textOf(result) {
  if (result?.isError || !Array.isArray(result?.content)) return ''
  return result.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function libraryIdOf(result) {
  const text = textOf(result)
  const match = text.match(/Context7-compatible library ID:\s*(\/(?:[\w.-]+\/){1,2}[\w.-]+)/i)
  return match?.[1] ?? null
}

// ⚠ This module takes an ENGINE ADAPTER, never the engine `$` itself. `claude plugin validate`
// refuses a `$` that crosses an import — it follows `$` only inside the file that received it —
// so passing `$` here made the whole plugin fail validation, which is the gate for shipping.
// The adapter is three closures built in hooks/hooks.js, where `$.noun.event(...)` is spelled out.
async function connectedContext7(engine) {
  const tools = await engine.listTools()
  const resolve = tools.find((tool) => tool?.mcp === true
    && /^mcp__.*context7.*__resolve-library-id$/i.test(tool.name))
  if (!resolve) return null
  const prefix = resolve.name.slice(0, -'__resolve-library-id'.length)
  if (!tools.some((tool) => tool?.mcp === true && tool.name === `${prefix}__query-docs`)) return null
  return prefix.slice('mcp__'.length)
}

async function waitBeforeDeadline(engine, operation, timeoutMs) {
  const timedOut = Symbol('context7 timeout')
  const timeout = engine.sleep(timeoutMs, { signal: engine.signal }).then(() => timedOut)
  const result = await Promise.race([operation, timeout])
  return result === timedOut ? { timedOut: true, timeoutMs } : { result }
}

async function callBeforeDeadline(engine, server, tool, args, startedAt) {
  // `await`: the real engine's clock answers now() asynchronously although its types say number;
  // a Promise here made elapsed NaN and every sleep refuse (measured 2026-09-21).
  const elapsed = (await engine.now()) - startedAt
  const timeoutMs = Math.max(0, Math.min(CALL_TIMEOUT_MS, TOTAL_TIMEOUT_MS - elapsed))
  return waitBeforeDeadline(engine, engine.call(server, tool, args), timeoutMs)
}

export async function queryContext7(engine, question, library) {
  const startedAt = await engine.now()
  try {
    const discovery = await waitBeforeDeadline(
      engine, connectedContext7(engine), TOTAL_TIMEOUT_MS,
    )
    if (discovery.timedOut) {
      return { answer: null, reason: `tool discovery timed out after ${discovery.timeoutMs} ms` }
    }
    const server = discovery.result
    if (!server) return { answer: null, reason: 'no connected context7 server was found' }
    const resolvedCall = await callBeforeDeadline(engine, server, 'resolve-library-id', {
      libraryName: library,
      query: question,
    }, startedAt)
    if (resolvedCall.timedOut) {
      return { answer: null, reason: `resolve-library-id timed out after ${resolvedCall.timeoutMs} ms` }
    }
    const libraryId = libraryIdOf(resolvedCall.result)
    if (!libraryId) return { answer: null, reason: `no library id was found for ${library}` }
    const docsCall = await callBeforeDeadline(
      engine, server, 'query-docs', { libraryId, query: question }, startedAt,
    )
    if (docsCall.timedOut) {
      return { answer: null, reason: `query-docs timed out after ${docsCall.timeoutMs} ms` }
    }
    const answer = textOf(docsCall.result)
    if (!answer || /^(?:documentation not found|no documentation|error fetching)/i.test(answer)) {
      return { answer: null, reason: 'context7 returned no documentation' }
    }
    return { answer, reason: null }
  } catch (error) {
    if (engine.signal?.aborted) throw error
    return { answer: null, reason: `context7 failed: ${String(error?.message ?? 'unknown error').slice(0, 80)}` }
  }
}
