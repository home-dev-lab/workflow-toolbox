// deep-search — the WebSearch substitution.
//
// A question about Claude Code itself is answered from the local documentation mirror
// (~/.claude-code-docs, kept current by the magic-claude-docs plugin): free, offline, and
// more current than the model's own memory. Every other question falls through to the
// ordinary web search, unchanged.
//
// The engine contract this relies on, read from the generated declarations (claude-code.d.ts,
// written by Claude Code 2.1.270): a `tool.call` hook returns `{ result }` to answer in the
// tool's place, and WebSearch's result is
//   { query, results: Array<{ tool_use_id, content: Array<{title,url}> } | string>,
//     durationSeconds, searchCount? }
// A string member of `results` is "text commentary from the model", which is what a mirror
// excerpt is.

import { route } from '../src/route.js'
import { searchBrave } from '../src/clients/brave.js'
import { searchExa } from '../src/clients/exa.js'
import { libraryFromQuestion, queryContext7 } from '../src/context7.js'

const MIRROR_DIR = '.claude-code-docs'
const MANIFEST = 'docs_manifest.json'
const EXA_REFUSAL_PREFIX = 'deep-search:exa-key-refused:'

// Detection uses the ENGINE's filesystem and environment, never node's: a hooks module has
// no node. The shape handed to route() is the same one detect.js produces.
// ⚠ This detection is a TWIN of src/detect.js and has drifted before. The twin exists because a
// hooks module has no node and cannot import detect.js; keep the two in step by hand, and see
// CROSS-PLATFORM.md.
//
// ⚠ `$.env.get` takes a LITERAL name: `claude plugin validate` refuses a computed argument, which
// is why environment variables are read in separate literal calls rather than in a loop.
async function homeFor($) {
  const home = await $.env.get('HOME')
  if (home) return home
  const profile = await $.env.get('USERPROFILE')
  if (profile) return profile
  const drive = await $.env.get('HOMEDRIVE')
  const homePath = await $.env.get('HOMEPATH')
  if (drive && homePath) return `${drive.replace(/[\\/]+$/, '')}\\${homePath.replace(/^[\\/]+/, '')}`
  return null
}

// The engine gives no platform, so the separator is read off the home directory itself: a Windows
// home is a drive letter or a UNC path. That is a heuristic, and it is the honest one available —
// a path already written with backslashes is joined with backslashes.
function separatorFor(home) {
  return /^[A-Za-z]:/.test(home) || home.startsWith('\\\\') ? '\\' : '/'
}

async function providersFor($) {
  const home = await homeFor($)
  if (!home) {
    return {
      mirror: { available: false, reason: 'none of HOME, USERPROFILE or HOMEDRIVE and HOMEPATH is set' },
      ...(await remoteProviders($)),
    }
  }
  const separator = separatorFor(home)
  const path = `${home.replace(/[\\/]+$/, '')}${separator}${MIRROR_DIR}`
  if (!(await $.fs.exists(path))) {
    return { mirror: { available: false, reason: 'the documentation mirror is not installed' }, ...(await remoteProviders($)) }
  }
  if (!(await $.fs.exists(`${path}${separator}${MANIFEST}`))) {
    return { mirror: { available: false, reason: 'the mirror has no manifest yet' }, ...(await remoteProviders($)) }
  }
  return { mirror: { available: true, path }, ...(await remoteProviders($)) }
}

// ⚠ The mirror was the only provider this function reported, so `route` never saw a key and
// every non-Claude-Code question came back as `none` — the Brave and Exa branches were
// unreachable however well they were wired. Detection and routing must name the SAME set.
async function remoteProviders($) {
  const brave = await $.env.get('BRAVE_API_KEY')
  const braveSearch = await $.env.get('BRAVE_SEARCH_API_KEY')
  const exa = await $.env.get('EXA_API_KEY')
  return {
    brave: brave || braveSearch
      ? { available: true }
      : { available: false, reason: 'BRAVE_API_KEY or BRAVE_SEARCH_API_KEY is not set' },
    exa: exa ? { available: true } : { available: false, reason: 'EXA_API_KEY is not set' },
    opencode: { available: false, reason: 'the deep-research rung is not wired into this hook' },
  }
}

// ⚠ The mirror's own SEMANTIC search cannot run on this machine as installed: its
// dependencies are absent and its pre-computed embeddings download answers HTTP 404
// (measured 2026-09-20 21:41 +01:00). A hook that depended on it alone would fall through
// silently on every question — correct behaviour, and useless.
//
// So the primary path needs NOTHING but the files already on disk: the manifest names every
// page and its title, and a page is markdown. The semantic search becomes an enhancement for
// the day its index exists, never a precondition.
const STOP = new Set(['what', 'when', 'where', 'which', 'does', 'do', 'the', 'and', 'for', 'with',
  'how', 'why', 'that', 'this', 'from', 'into', 'about', 'search', 'web', 'find', 'tell', 'summarise',
  'summarize', 'then', 'receive', 'receives', 'comment', 'quelle', 'quelles', 'dans', 'pour', 'les',
  'des', 'est', 'sur', 'une', 'que', 'qui', 'claude', 'code', 'avec', 'sont', 'aux', 'par', 'plus',
  'puis', 'trouver', 'utiliser', 'use', 'is', 'are', 'can', 'you', 'your', 'our', 'its', 'ou', 'et'])

const TRANSLATE = new Map([
  ['connecter', 'connect'], ['serveur', 'server'], ['serveurs', 'server'], ['configurer', 'configure'],
  ['creer', 'create'], ['etendre', 'extend'], ['competence', 'skill'], ['competences', 'skill'],
  ['installer', 'install'], ['decouvrir', 'discover'], ['ligne', 'line'], ['etat', 'status'],
  ['cout', 'cost'], ['couts', 'cost'], ['memoire', 'memory'], ['instructions', 'instruction'],
  ['option', 'flag'], ['options', 'flag'],
])

function canonical(word) {
  const translated = TRANSLATE.get(word) ?? word
  if (translated === 'status') return translated
  if (translated.endsWith('ies') && translated.length > 4) return `${translated.slice(0, -3)}y`
  if (translated.endsWith('s') && translated.length > 4) return translated.slice(0, -1)
  return translated
}

function terms(query) {
  const plain = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return (plain.match(/[a-z][a-z0-9]{1,}/g) ?? [])
    .filter((word) => !STOP.has(word)).map(canonical).filter((word) => !STOP.has(word))
}

function keywords(query) {
  return [...new Set(terms(query))]
}

function frequencies(words) {
  const counts = new Map()
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  return counts
}

function mirrorEntryPath(mirrorPath, name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null
  if (/^(?:[\\/]|[A-Za-z]:)/.test(name)) return null
  const segments = name.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) return null
  const relative = segments.filter((segment) => segment && segment !== '.')
  if (relative.length === 0) return null
  const separator = separatorFor(mirrorPath)
  return `${mirrorPath.replace(/[\\/]+$/, '')}${separator}${relative.join(separator)}`
}

async function searchablePages($, mirrorPath, files) {
  const pages = []
  for (const [name, meta] of Object.entries(files)) {
    const path = mirrorEntryPath(mirrorPath, name)
    if (!path) continue
    let markdown
    try { markdown = await $.fs.read(path) } catch { continue }
    const title = meta?.title ?? name
    const headings = markdown.split('\n').filter((line) => /^#{1,3}\s/.test(line)).join(' ')
    const openingWords = terms(markdown.slice(0, 12000))
    pages.push({
      name,
      title,
      url: meta?.original_url ?? null,
      titleWords: new Set(keywords(`${name} ${title}`)),
      headingWords: new Set(keywords(headings)),
      opening: frequencies(openingWords),
      length: openingWords.length,
    })
  }
  return pages
}

export async function bestPages($, mirrorPath, query, limit = 2) {
  let manifest
  try {
    manifest = JSON.parse(await $.fs.read(`${mirrorPath}/docs_manifest.json`))
  } catch { return [] }
  const files = manifest?.files
  if (!files || typeof files !== 'object') return []
  const words = keywords(query)
  if (words.length === 0) return []
  const pages = await searchablePages($, mirrorPath, files)
  if (pages.length === 0) return []
  const documentFrequency = new Map(words.map((word) => [word, pages
    .filter((page) => page.titleWords.has(word) || page.headingWords.has(word) || page.opening.has(word)).length]))
  const scored = []
  for (const page of pages) {
    let score = 0
    let matches = 0
    let titleMatches = 0
    for (const word of words) {
      const title = page.titleWords.has(word)
      const heading = page.headingWords.has(word)
      const count = page.opening.get(word) ?? 0
      if (!title && !heading && count === 0) continue
      matches += 1
      if (title) titleMatches += 1
      const rarity = Math.log((pages.length + 1) / ((documentFrequency.get(word) ?? 0) + 1)) + 1
      const content = Math.min(count, 4) / (1 + page.length / 1000)
      score += rarity * ((title ? 6 : 0) + (heading ? 3 : 0) + content)
    }
    const enoughTerms = matches >= (words.length === 1 ? 1 : 2) || titleMatches > 0
    if (enoughTerms && score >= 8) {
      scored.push({ name: page.name, title: page.title, url: page.url, score })
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

async function readPages($, mirrorPath, pages, budget = 6000) {
  const parts = []
  let spent = 0
  for (const page of pages) {
    if (spent >= budget) break
    const path = mirrorEntryPath(mirrorPath, page.name)
    if (!path) continue
    let text
    try { text = await $.fs.read(path) } catch { continue }
    const slice = text.slice(0, Math.max(0, budget - spent))
    spent += slice.length
    parts.push({ page, slice })
  }
  return parts
}


// The engine's own HTTP, adapted to what the clients expect. `$.http.fetch` answers
// `{ status, ok, headers, text }` — a plain record, no `json()` and no `headers.get`, which is
// exactly what `requestProvider` reads to recover a rate-limit reset. A hooks module has no
// global fetch, so this adapter is the seam between the two.
function engineFetch($) {
  return async (url, init = {}) => {
    const response = await $.http.fetch(url, init)
    const headers = response.headers ?? {}
    return {
      status: response.status,
      ok: response.ok,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      json: async () => JSON.parse(response.text),
      text: async () => response.text,
    }
  }
}

function renderResults(providerLabel, normalised) {
  const hits = (normalised?.results ?? []).filter((hit) => hit?.url)
  if (hits.length === 0) return null
  const lines = hits.slice(0, 10).map((hit) => {
    const date = hit.publishedAt ? ` — ${hit.publishedAt}` : ''
    return `- [${hit.title ?? hit.url}](${hit.url})${date}\n  ${hit.snippet ?? ''}`.trimEnd()
  })
  return `Answered by ${providerLabel} instead of the default web search.\n\n${lines.join('\n')}`
}

function withAnswerNotice(answer, notice) {
  const results = answer?.result?.results
  if (!Array.isArray(results)) return answer
  return { ...answer, result: { ...answer.result, results: [notice, ...results] } }
}

async function fallThroughWithNotice(next, event, notice) {
  return withAnswerNotice(await next(event), notice)
}

async function exaRefusalNotice($) {
  const sessionId = await $.session.id()
  const key = `${EXA_REFUSAL_PREFIX}${sessionId}`
  if (await $.store.get(key)) return null
  await $.store.set(key, true)
  return 'Exa refused the API key; answered by the default web search instead.'
}

export const register = (on) => {
  on('tool.call', { tool: 'WebSearch' }, async ($, event, next) => {
    const query = typeof event.query === 'string' ? event.query : ''
    if (!query.trim()) return next(event)

    const providers = await providersFor($)
    const decision = route(query, providers)
    let context7Notice = null

    // Rung 1 keeps precedence. For every other route, an explicitly recognised third-party
    // product gets its own documentation before any general web provider is attempted.
    if (decision.provider !== 'mirror') {
      const library = libraryFromQuestion(query)
      if (library) {
        const started = Date.now()
        const context7 = await queryContext7({
          listTools: () => $.tool.list(),
          call: (server, tool, args) => $.mcp.call(server, tool, args),
          sleep: (ms, options) => $.clock.sleep(ms, options),
          now: () => $.clock.now(),
          signal: next.signal,
        }, query, library)
        if (context7.answer) {
          return {
            result: {
              query,
              results: [`Answered from ${library}'s documentation through context7 — no web search was performed.\n\n${context7.answer}`],
              durationSeconds: (Date.now() - started) / 1000,
              searchCount: 0,
            },
          }
        }
        context7Notice = `Context7 did not answer: ${context7.reason}.`
        if (decision.provider !== 'brave' && decision.provider !== 'exa') {
          return fallThroughWithNotice(next, event, context7Notice)
        }
      }
    }

    // Brave and Exa extend the ordinary web search rather than replacing it: anything they
    // cannot serve — no key, an error, an exhausted quota, an empty result — falls through to
    // `next(event)`, which is the search the session asked for in the first place. A rung that
    // answers badly is worse than the rung below it.
    if (decision.provider === 'brave' || decision.provider === 'exa') {
      const started = Date.now()
      const isBrave = decision.provider === 'brave'
      // ⚠ Literal `$.env.get` calls only: the engine lists the variables a module reads and refuses
      // `$.env.get(<expression>)` outright. Brave is read under both names it is documented with.
      let apiKey
      if (isBrave) {
        const brave = await $.env.get('BRAVE_API_KEY')
        const braveSearch = await $.env.get('BRAVE_SEARCH_API_KEY')
        apiKey = brave || braveSearch
      } else {
        apiKey = await $.env.get('EXA_API_KEY')
      }
      if (!apiKey) {
        return context7Notice ? fallThroughWithNotice(next, event, context7Notice) : next(event)
      }
      let rendered = null
      try {
        const search = isBrave ? searchBrave : searchExa
        const normalised = await search(query, { ...decision.call.options, apiKey }, { fetch: engineFetch($) })
        rendered = renderResults(isBrave ? 'Brave' : 'Exa', normalised)
      } catch (error) {
        await $.ui.log(`deep-search: ${decision.provider} did not answer (${String(error?.classification ?? error?.message ?? 'unknown').slice(0, 60)}) — falling through to the web search`)
        let answer = await next(event)
        if (!isBrave && (error?.status === 401 || error?.status === 403)) {
          const notice = await exaRefusalNotice($)
          if (notice) answer = withAnswerNotice(answer, notice)
        }
        return context7Notice
          ? withAnswerNotice(answer, context7Notice)
          : answer
      }
      if (!rendered) {
        return context7Notice
          ? fallThroughWithNotice(next, event, context7Notice)
          : next(event)
      }
      if (context7Notice) rendered = `${context7Notice}\n${rendered}`
      return {
        result: { query, results: [rendered], durationSeconds: (Date.now() - started) / 1000, searchCount: 1 },
      }
    }

    if (decision.provider !== 'mirror') return next(event)

    const started = Date.now()
    const pages = await bestPages($, decision.call.path, query)
    const parts = await readPages($, decision.call.path, pages)
    const answer = parts.length === 0 ? null : parts
      .map(({ page, slice }) => `### ${page.title}${page.url ? ` — ${page.url}` : ''}\n\n${slice}`)
      .join('\n\n---\n\n')
    // No answer is not an error: the mirror simply could not serve this one, and a web search
    // is the right thing to happen next. Answering with an empty result would hide that.
    if (!answer) return next(event)

    return {
      result: {
        query,
        results: [
          `Answered from the local Claude Code documentation mirror (${decision.call.path}) — no web search was performed.\n\n${answer}`,
        ],
        durationSeconds: (Date.now() - started) / 1000,
        searchCount: 0,
      },
    }
  })
}
