import assert from 'node:assert/strict'
import test from 'node:test'

import { register } from '../hooks/hooks.js'

const context7Tools = [
  { name: 'mcp__plugin_context7_context7__resolve-library-id', mcp: true },
  { name: 'mcp__plugin_context7_context7__query-docs', mcp: true },
]

function hookHandler() {
  let handler
  register((_event, _filter, callback) => { handler = callback })
  return handler
}

function engine(overrides = {}) {
  return {
    env: { get: async () => undefined },
    fs: { exists: async () => false },
    tool: { list: async () => context7Tools },
    clock: { now: () => 0, sleep: () => new Promise(() => {}) },
    mcp: {
      call: async (_server, tool) => tool === 'resolve-library-id'
        ? { isError: false, content: [{ type: 'text', text: '- Context7-compatible library ID: /facebook/react' }] }
        : { isError: false, content: [{ type: 'text', text: 'React effect cleanup runs before the next effect.' }] },
    },
    ...overrides,
  }
}

test('a third-party library question uses context7 resolve then docs before web search', async () => {
  const calls = []
  const $ = engine({
    mcp: {
      call: async (server, tool, args) => {
        calls.push({ server, tool, args })
        return tool === 'resolve-library-id'
          ? { isError: false, content: [{ type: 'text', text: '- Context7-compatible library ID: /facebook/react' }] }
          : { isError: false, content: [{ type: 'text', text: 'Use the cleanup returned by useEffect.' }] }
      },
    },
  })
  let fellThrough = false

  const result = await hookHandler()($, { query: 'How does useEffect cleanup work in React?' }, () => {
    fellThrough = true
  })

  assert.equal(fellThrough, false)
  assert.deepEqual(calls, [
    {
      server: 'plugin_context7_context7',
      tool: 'resolve-library-id',
      args: { libraryName: 'React', query: 'How does useEffect cleanup work in React?' },
    },
    {
      server: 'plugin_context7_context7',
      tool: 'query-docs',
      args: { libraryId: '/facebook/react', query: 'How does useEffect cleanup work in React?' },
    },
  ])
  assert.match(result.result.results[0], /Answered from React's documentation through context7/)
  assert.match(result.result.results[0], /Use the cleanup returned by useEffect/)
  assert.equal(result.result.searchCount, 0)
})

test('a resolve slower than the old 1.5 second limit still reaches context7 docs', async () => {
  const calls = []
  const $ = engine({
    clock: {
      now: () => 0,
      sleep: (ms) => ms <= 1500 ? Promise.resolve() : new Promise(() => {}),
    },
    mcp: {
      call: async (_server, tool) => {
        calls.push(tool)
        if (tool === 'resolve-library-id') {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return tool === 'resolve-library-id'
          ? { isError: false, content: [{ type: 'text', text: '- Context7-compatible library ID: /vitest-dev/vitest' }] }
          : { isError: false, content: [{ type: 'text', text: 'Set testTimeout in the Vitest configuration.' }] }
      },
    },
  })

  const result = await hookHandler()($, { query: 'Vitest how to configure test timeout' }, () => {
    throw new Error('web search should not run')
  })

  assert.deepEqual(calls, ['resolve-library-id', 'query-docs'])
  assert.match(result.result.results[0], /Set testTimeout/)
})

test('a non-library question gets nowhere near context7', async () => {
  let listed = false
  let called = false
  const $ = engine({
    tool: { list: async () => { listed = true; return context7Tools } },
    mcp: { call: async () => { called = true } },
  })
  const event = { query: 'What is the weather in Paris today?' }

  const result = await hookHandler()($, event, (forwarded) => ({ forwarded }))

  assert.deepEqual(result, { forwarded: event })
  assert.equal(listed, false)
  assert.equal(called, false)
})

for (const query of ['How should I react to a failed build?', 'What is a node in a binary tree?']) {
  test(`ambiguous prose gets nowhere near context7: ${query}`, async () => {
    let listed = false
    const $ = engine({ tool: { list: async () => { listed = true; return context7Tools } } })

    await hookHandler()($, { query }, (forwarded) => ({ forwarded }))

    assert.equal(listed, false)
  })
}

test('missing context7 tools name the reason in the ordinary web answer', async () => {
  let called = false
  const $ = engine({
    tool: { list: async () => [{ name: 'WebSearch', mcp: false }] },
    mcp: { call: async () => { called = true } },
  })
  const event = { query: 'How do Prisma relations work?' }

  const result = await hookHandler()($, event, () => webAnswer('web result'))

  assert.match(result.result.results[0], /no connected context7 server was found/)
  assert.equal(called, false)
})

test('an unresolved library names the reason in the ordinary web answer', async () => {
  const calls = []
  const $ = engine({
    mcp: {
      call: async (_server, tool) => {
        calls.push(tool)
        return { isError: false, content: [{ type: 'text', text: 'No libraries found matching the provided name.' }] }
      },
    },
  })
  const event = { query: 'How do Prisma relations work?' }

  const result = await hookHandler()($, event, () => webAnswer('web result'))

  assert.match(result.result.results[0], /no library id was found for Prisma/)
  assert.deepEqual(calls, ['resolve-library-id'])
})

test('empty context7 documentation names the reason in the ordinary web answer', async () => {
  const $ = engine({
    mcp: {
      call: async (_server, tool) => tool === 'resolve-library-id'
        ? { isError: false, content: [{ type: 'text', text: '- Context7-compatible library ID: /prisma/prisma' }] }
        : { isError: false, content: [{ type: 'text', text: '   ' }] },
    },
  })
  const event = { query: 'How do Prisma relations work?' }

  const result = await hookHandler()($, event, () => webAnswer('web result'))

  assert.match(result.result.results[0], /context7 returned no documentation/)
})

test('a context7 error names the reason in the ordinary web answer', async () => {
  const $ = engine({ mcp: { call: async () => { throw new Error('offline') } } })
  const event = { query: 'How do Prisma relations work?' }

  const result = await hookHandler()($, event, () => webAnswer('web result'))

  assert.match(result.result.results[0], /context7 failed: offline/)
})

test('a slow context7 resolve names the call and deadline in the ordinary web answer', async () => {
  let sleeps = 0
  const $ = engine({
    clock: { now: () => 0, sleep: async () => { sleeps += 1 } },
    mcp: { call: async () => new Promise(() => {}) },
  })
  const event = { query: 'How do Prisma relations work?' }

  const result = await hookHandler()($, event, () => webAnswer('web result'))

  assert.match(result.result.results[0], /resolve-library-id timed out after 8000 ms/)
  assert.equal(sleeps, 2)
})

test('a slow context7 docs call names that call in the ordinary web answer', async () => {
  const $ = engine({
    clock: { now: () => 0, sleep: async () => {} },
    mcp: {
      call: async (_server, tool) => tool === 'resolve-library-id'
        ? { isError: false, content: [{ type: 'text', text: '- Context7-compatible library ID: /prisma/prisma' }] }
        : new Promise(() => {}),
    },
  })

  const result = await hookHandler()(
    $, { query: 'How do Prisma relations work?' }, () => webAnswer('web result'),
  )

  assert.match(result.result.results[0], /query-docs timed out after 8000 ms/)
})

test('an aborted dispatch stops waiting for context7', async () => {
  const controller = new AbortController()
  const $ = engine({
    clock: {
      now: () => 0,
      sleep: (_ms, { signal }) => new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('dispatch abandoned'))
          return
        }
        signal.addEventListener('abort', () => reject(new Error('dispatch abandoned')), { once: true })
      }),
    },
    mcp: { call: async () => new Promise(() => {}) },
  })
  const next = () => webAnswer('web result')
  next.signal = controller.signal

  const pending = hookHandler()($, { query: 'How do Prisma relations work?' }, next)
  controller.abort()

  await assert.rejects(pending, /dispatch abandoned/)
})

function webAnswer(text) {
  return { result: { query: 'q', results: [text], durationSeconds: 0, searchCount: 1 } }
}

// Measured 2026-09-21 on the real engine: the rung failed with "$.clock.sleep takes a non-negative
// number of milliseconds" although every fake passed. The fakes' clock returned a number from now();
// this one returns a promise and refuses a non-number sleep, which is how the real engine answered.
test('context7 answers when the engine clock returns now() asynchronously', async () => {
  const slept = []
  const $ = engine({
    clock: {
      now: async () => 1000,
      sleep: (ms) => {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
          throw new Error('deep-search: $.clock.sleep takes a non-negative number of milliseconds')
        }
        slept.push(ms)
        return new Promise(() => {})
      },
    },
  })

  const result = await hookHandler()($, { query: 'Vitest how to configure test timeout' }, () => {
    throw new Error('web search should not run')
  })

  assert.match(result.result.results[0], /Answered from Vitest's documentation through context7/)
  assert.ok(slept.length > 0 && slept.every((ms) => ms > 0))
})
