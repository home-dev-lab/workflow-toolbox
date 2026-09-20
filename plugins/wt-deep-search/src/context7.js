const CALL_TIMEOUT_MS = 1500

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

async function callBeforeDeadline(engine, server, tool, args) {
  const timeout = engine.sleep(CALL_TIMEOUT_MS).then(() => null)
  return Promise.race([engine.call(server, tool, args), timeout])
}

export async function queryContext7(engine, question, library) {
  try {
    const server = await connectedContext7(engine)
    if (!server) return null
    const resolved = await callBeforeDeadline(engine, server, 'resolve-library-id', {
      libraryName: library,
      query: question,
    })
    const libraryId = libraryIdOf(resolved)
    if (!libraryId) return null
    const docs = await callBeforeDeadline(engine, server, 'query-docs', { libraryId, query: question })
    const answer = textOf(docs)
    if (!answer || /^(?:documentation not found|no documentation|error fetching)/i.test(answer)) return null
    return answer
  } catch {
    return null
  }
}
