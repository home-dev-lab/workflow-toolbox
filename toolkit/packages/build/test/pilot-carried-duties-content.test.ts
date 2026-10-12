import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PILOT = readFileSync(join(REPO_ROOT, 'plugin/agent-templates/pilot.md'), 'utf8')

// Source-text lock on purpose: the template is the normative deliverable. These duties come from
// shipped rules a pilot may not load (a lean pilot runs without the CLAUDE.md and rules prefix),
// so the definition itself must carry them.
describe('pilot template carries the rule duties it needs without the rules prefix', () => {
  it('refuses to start a card missing a label axis or with an open dependency', () => {
    expect(PILOT).toMatch(/Never start a card with no priority, type or effort label, or whose `Depends-on:` line names a card not Done/)
  })

  it('makes a step back list routes with priors and a kill criterion', () => {
    expect(PILOT).toMatch(/list 2-3 distinct routes with a prior each, write the chosen route's kill criterion before resuming/)
  })

  it('makes an escalation name its recommendation and fixes structural drift first', () => {
    expect(PILOT).toContain('An escalation names the option you recommend and why; a bare menu is not an escalation.')
    expect(PILOT).toMatch(/drifted from the ordinary architecture for its kind[\s\S]{0,140}fixed first and then reported/)
  })

  it('grounds a stated cause with a refuting grep and a control', () => {
    expect(PILOT).toMatch(/Before writing 'the cause is X'[\s\S]{0,120}control string known present/)
    expect(PILOT).toContain('seed a multi-row check with a row whose answer you already know')
    expect(PILOT).toMatch(/hosted platform's behaviour is read in its documentation/)
  })

  it('states a cross-platform verdict and the three high-impact answers', () => {
    expect(PILOT).toMatch(/cross-platform verdict for every shipped increment[\s\S]{0,160}silently return a plausible value/)
    expect(PILOT).toMatch(/was the failure exercised, did it run on real conditions or only fixtures, what can go wrong in the mechanism itself/)
  })

  it('closes the report with the five sections, status words and a pasted e2e', () => {
    expect(PILOT).toMatch(/Close the report with `## Implemented`, `## Verification`, `## Independent Review`, `## Decisions`, `## Remaining Risks`/)
    expect(PILOT).toContain('`e2e not run: <reason>`')
  })

  it('keeps an isolated delegate tree away from a running external lane', () => {
    expect(PILOT).toMatch(/isolation tree[\s\S]{0,200}external lane[\s\S]{0,200}create that worktree yourself/)
  })

  it('carries no owner-specific language policy', () => {
    expect(PILOT).not.toContain('Write every artefact in English')
  })
})
