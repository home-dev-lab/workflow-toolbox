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
    clock: { sleep: () => new Promise(() => {}) },
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

test('missing context7 tools preserve ordinary web search', async () => {
  let called = false
  const $ = engine({
    tool: { list: async () => [{ name: 'WebSearch', mcp: false }] },
    mcp: { call: async () => { called = true } },
  })
  const event = { query: 'How do Prisma relations work?' }

  const result = await hookHandler()($, event, (forwarded) => ({ forwarded }))

  assert.deepEqual(result, { forwarded: event })
  assert.equal(called, false)
})

test('an unresolved library preserves ordinary web search', async () => {
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

  const result = await hookHandler()($, event, (forwarded) => ({ forwarded }))

  assert.deepEqual(result, { forwarded: event })
  assert.deepEqual(calls, ['resolve-library-id'])
})

test('empty context7 documentation preserves ordinary web search', async () => {
  const $ = engine({
    mcp: {
      call: async (_server, tool) => tool === 'resolve-library-id'
        ? { isError: false, content: [{ type: 'text', text: '- Context7-compatible library ID: /prisma/prisma' }] }
        : { isError: false, content: [{ type: 'text', text: '   ' }] },
    },
  })
  const event = { query: 'How do Prisma relations work?' }

  const result = await hookHandler()($, event, (forwarded) => ({ forwarded }))

  assert.deepEqual(result, { forwarded: event })
})

test('a context7 error preserves ordinary web search', async () => {
  const $ = engine({ mcp: { call: async () => { throw new Error('offline') } } })
  const event = { query: 'How do Prisma relations work?' }

  const result = await hookHandler()($, event, (forwarded) => ({ forwarded }))

  assert.deepEqual(result, { forwarded: event })
})

test('a slow context7 call reaches ordinary web search at the deadline', async () => {
  let sleeps = 0
  const $ = engine({
    clock: { sleep: async () => { sleeps += 1 } },
    mcp: { call: async () => new Promise(() => {}) },
  })
  const event = { query: 'How do Prisma relations work?' }

  const result = await hookHandler()($, event, (forwarded) => ({ forwarded }))

  assert.deepEqual(result, { forwarded: event })
  assert.equal(sleeps, 1)
})
