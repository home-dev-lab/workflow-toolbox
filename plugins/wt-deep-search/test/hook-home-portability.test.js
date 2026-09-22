import assert from 'node:assert/strict'
import test from 'node:test'

import { register } from '../hooks/hooks.js'

// The hook cannot import src/detect.js — a hooks module has no Node, so it detects against the
// ENGINE's `$.fs` and `$.env`. That makes it a TWIN of detect.js, and a twin drifts: detect.js
// learned Windows home resolution while this copy still read HOME alone and joined with '/'.
// On a Windows machine with the mirror installed, that reported the mirror as absent — a
// well-formed answer indistinguishable from an honest "you have not installed it".

function hookHandler() {
  let handler
  register((_event, _filter, callback) => { handler = callback })
  return handler
}

function windowsEngine(vars, presentPaths) {
  const present = new Set(presentPaths)
  return {
    env: { get: async (name) => vars[name] },
    fs: {
      exists: async (path) => present.has(path),
      list: async () => [],
      read: async () => JSON.stringify({ pages: [] }),
    },
    tool: { list: async () => [] },
    clock: { sleep: () => new Promise(() => {}) },
    ui: { log: () => {} },
  }
}

async function mirrorReason($) {
  const handler = hookHandler()
  let seen = null
  const event = { query: 'what changed in the Claude Code changelog' }
  await handler($, event, (forwarded) => { seen = forwarded; return { forwarded } })
  return seen
}

test('the hook finds the mirror from USERPROFILE when HOME is unset', async () => {
  const seenPaths = []
  const $ = windowsEngine({ USERPROFILE: 'C:\\Users\\tester' }, [])
  $.fs.exists = async (path) => { seenPaths.push(path); return false }
  await mirrorReason($)
  assert.deepEqual(seenPaths, ['C:\\Users\\tester\\.claude-code-docs'])
})

test('the hook resolves a Windows home before giving up on the mirror', async () => {
  const seenPaths = []
  const $ = windowsEngine({ HOMEDRIVE: 'D:', HOMEPATH: '\\Profiles\\tester' }, [])
  $.fs.exists = async (path) => { seenPaths.push(path); return false }
  await mirrorReason($)
  assert.deepEqual(seenPaths, ['D:\\Profiles\\tester\\.claude-code-docs'])
})

test('a POSIX home is still joined with a forward slash', async () => {
  const seenPaths = []
  const $ = windowsEngine({ HOME: '/home/tester/' }, [])
  $.fs.exists = async (path) => { seenPaths.push(path); return false }
  await mirrorReason($)
  assert.deepEqual(seenPaths, ['/home/tester/.claude-code-docs'])
})
