import assert from 'node:assert/strict'
import test from 'node:test'

import { register } from '../hooks/hooks.js'

function hookHandler() {
  let handler
  register((_event, _filter, callback) => { handler = callback })
  return handler
}

function statefulStore() {
  const values = new Map()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, value) },
  }
}

function engine(sessionId, store, status) {
  return {
    env: { get: async (name) => name === 'EXA_API_KEY' ? 'test-key' : undefined },
    fs: { exists: async () => false },
    tool: { list: async () => [] },
    http: {
      fetch: async () => ({ status, ok: false, headers: {}, text: '{"error":"refused"}' }),
    },
    ui: { log: async () => {} },
    session: { id: async () => sessionId },
    store,
  }
}

function nextWebSearch() {
  return {
    result: {
      query: 'current weather',
      results: ['default web result'],
      durationSeconds: 0,
      searchCount: 1,
    },
  }
}

for (const status of [401, 403]) {
  test(`Exa ${status} refusal is shown once in a session and again in another session`, async () => {
    const store = statefulStore()
    const handler = hookHandler()
    const event = { query: 'current weather' }

    const first = await handler(engine('session-a', store, status), event, nextWebSearch)
    const second = await handler(engine('session-a', store, status), event, nextWebSearch)
    const other = await handler(engine('session-b', store, status), event, nextWebSearch)

    assert.match(first.result.results[0], /Exa refused the API key; answered by the default web search instead/)
    assert.equal(second.result.results.some((line) => /Exa refused/.test(line)), false)
    assert.match(other.result.results[0], /Exa refused the API key; answered by the default web search instead/)
  })
}
