import { spawn, type SpawnOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'
// @ts-expect-error plugin runtime module
import * as parser from '../../../../plugin/bin/lib/suite-lock-direct-run.mjs'
// @ts-expect-error standalone integration scenarios also run without Vitest
import { assertDirect, assertNoWait, assertTwoFiles, assertExclusive, assertPark, assertNested, assertOverrun, assertShort, assertTimerCancelled, assertParser } from './helpers/suite-lock-direct-scenarios.mjs'

const cli = fileURLToPath(new URL('../../../../plugin/bin/wt-suite-lock.mjs', import.meta.url))

// Keep the real spawn boundary visible to the scheduling-policy census.
function spawnChild(command: string, args: string[], options: SpawnOptions) {
  return spawn(command, args, options)
}

describe('one-file Node direct runs', () => {
  it('L1: leaves status and the journal empty while running', async () => { await assertDirect(cli, spawnChild) }, 60_000)
  it('L1b: completes without waiting behind an exclusive holder', async () => { await assertNoWait(cli, spawnChild) }, 60_000)
  it('L2: keeps two-file light runs in the queue', async () => { await assertTwoFiles(cli, spawnChild) }, 60_000)
  it('L3: keeps exclusive one-file runs in the queue', async () => { await assertExclusive(cli, spawnChild) }, 60_000)
  it('L3b: keeps valid park requests in the queue', async () => { await assertPark(cli, spawnChild) }, 60_000)
  it('L5: lets nested exclusive work take its own ticket', async () => { await assertNested(cli, spawnChild) }, 60_000)
  it('L6: warns once on overrun without stopping the child', async () => { await assertOverrun(cli, spawnChild) }, 60_000)
  it('short runs exit cleanly without light-ticket wording', async () => { await assertShort(cli, spawnChild) }, 60_000)
  it('cancels the overrun timer when a direct run ends', async () => { await assertTimerCancelled(parser) })
  it('L4: accepts only the closed argv, filename and environment shapes', () => { assertParser(parser) })
})
