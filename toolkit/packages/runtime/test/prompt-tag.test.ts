import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '../src/fake.js'
import {
  PROMPT_TAG_PREFIX,
  buildObservedRoleSection,
  buildPromptTag,
  parsePromptTag,
  type PromptTagFields,
  withPromptTags,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// buildPromptTag / parsePromptTag — the wire format (single source of truth
// for both the emit side here and the observe ingest side).
// ---------------------------------------------------------------------------
describe('buildPromptTag / parsePromptTag', () => {
  it('round-trips label + phase', () => {
    const tag = buildPromptTag({ label: 'gen:0', phase: 'Generate' })
    expect(tag).not.toBeNull()
    expect(parsePromptTag(`${tag!}\n\nreal prompt`)).toEqual({ label: 'gen:0', phase: 'Generate' })
  })

  it('round-trips label only and phase only', () => {
    expect(parsePromptTag(`${buildPromptTag({ label: 'a:b:1' })!}\nbody`)).toEqual({ label: 'a:b:1' })
    expect(parsePromptTag(`${buildPromptTag({ phase: 'Rank' })!}\nbody`)).toEqual({ phase: 'Rank' })
  })

  it('returns null when no field is set', () => {
    expect(buildPromptTag({})).toBeNull()
    expect(buildPromptTag({ label: undefined, phase: undefined })).toBeNull()
  })

  it('escapes values that would break the comment or the attribute quoting', () => {
    const hostile = { label: 'a"b&c', phase: 'x --> y\nz <end>' }
    const tag = buildPromptTag(hostile)!
    // The tag stays a single line and never contains a premature comment close.
    expect(tag).not.toMatch(/\n/)
    expect(tag.indexOf('-->')).toBe(tag.length - 3)
    expect(parsePromptTag(`${tag}\nbody`)).toEqual(hostile)
  })

  it('parses only a tag at the very start of the text', () => {
    const tag = buildPromptTag({ label: 'x' })!
    expect(parsePromptTag(`preamble\n${tag}`)).toBeNull()
    expect(parsePromptTag('no tag here')).toBeNull()
    expect(parsePromptTag('')).toBeNull()
  })

  it('ignores a same-shaped comment that is not a wt-meta tag', () => {
    expect(parsePromptTag('<!-- note label="x" -->\nbody')).toBeNull()
  })

  it('the tag starts with the exported prefix (grep/startsWith contract)', () => {
    expect(buildPromptTag({ label: 'x' })!.startsWith(PROMPT_TAG_PREFIX)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// withPromptTags — one wrapping point that prefixes every agent() prompt with
// the tag derived from the call's label/phase opts (falling back to the last
// rt.phase() title, mirroring the sandbox's own phase-grouping semantics).
// ---------------------------------------------------------------------------
describe('withPromptTags', () => {
  it('prefixes the prompt with a tag built from opts.label and opts.phase', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const rt2 = withPromptTags(rt)
    await rt2.agent('do the thing', { label: 'score:0', phase: 'Rank' })
    const sent = rt.calls[0]!.prompt
    expect(parsePromptTag(sent)).toEqual({ label: 'score:0', phase: 'Rank' })
    expect(sent.endsWith('do the thing')).toBe(true)
  })

  it('falls back to the current rt.phase() title when opts.phase is absent', async () => {
    const rt = new FakeRuntime({ responses: ['ok', 'ok'] })
    const rt2 = withPromptTags(rt)
    rt2.phase('Refine')
    await rt2.agent('p1', { label: 'iter:0' })
    expect(parsePromptTag(rt.calls[0]!.prompt)).toEqual({ label: 'iter:0', phase: 'Refine' })
    // opts.phase still wins over the tracked phase.
    await rt2.agent('p2', { label: 'iter:1', phase: 'Verify' })
    expect(parsePromptTag(rt.calls[1]!.prompt)).toEqual({ label: 'iter:1', phase: 'Verify' })
  })

  it('forwards phase() to the wrapped rt (grouping still reaches the sandbox)', () => {
    const rt = new FakeRuntime()
    withPromptTags(rt).phase('Gen')
    expect(rt.phases).toContain('Gen')
  })

  it('leaves the prompt untouched when there is no label and no phase', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    await withPromptTags(rt).agent('bare prompt')
    expect(rt.calls[0]!.prompt).toBe('bare prompt')
  })

  it('appends an observed-role section after the prompt while keeping the tag on line 1', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const section = buildObservedRoleSection('implementer')
    await withPromptTags(rt, {
      observedBrief: ({ label }) => label === 'implementer' ? section : null,
    }).agent('do the thing', { label: 'implementer' })
    const sent = rt.calls[0]!.prompt
    expect(sent.split('\n')[0]).toBe(buildPromptTag({ label: 'implementer' }))
    expect(sent).toBe(`${buildPromptTag({ label: 'implementer' })}\n\ndo the thing\n\n${section}`)
  })

  it('leaves the prompt byte-identical when the observed-role hook returns null', async () => {
    const rtA = new FakeRuntime({ responses: ['ok'] })
    const rtB = new FakeRuntime({ responses: ['ok'] })
    await withPromptTags(rtA).agent('do the thing', { label: 'implementer' })
    await withPromptTags(rtB, { observedBrief: () => null }).agent('do the thing', { label: 'implementer' })
    expect(rtB.calls[0]!.prompt).toBe(rtA.calls[0]!.prompt)
  })

  it('does not append the same observed-role section twice under re-wrap', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const section = buildObservedRoleSection('implementer')
    const rt2 = withPromptTags(withPromptTags(rt, { observedBrief: () => section }), { observedBrief: () => section })
    await rt2.agent('body', { label: 'implementer' })
    const sent = rt.calls[0]!.prompt
    expect(sent.indexOf(section)).toBe(sent.lastIndexOf(section))
  })

  it('passes the same resolved phase to the tag and observed-role hook', async () => {
    const rt = new FakeRuntime({ responses: ['ok', 'ok'] })
    const seen: PromptTagFields[] = []
    const rt2 = withPromptTags(rt, {
      observedBrief: (fields) => {
        seen.push(fields)
        return null
      },
    })
    rt2.phase('Current')
    await rt2.agent('uses current', { label: 'worker' })
    await rt2.agent('uses opts', { label: 'worker', phase: 'Explicit' })
    expect(seen).toEqual([
      { label: 'worker', phase: 'Current' },
      { label: 'worker', phase: 'Explicit' },
    ])
    expect(parsePromptTag(rt.calls[0]!.prompt)).toEqual(seen[0])
    expect(parsePromptTag(rt.calls[1]!.prompt)).toEqual(seen[1])
  })

  it('does not double-tag an already-tagged prompt (idempotent under re-wrap)', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const rt2 = withPromptTags(withPromptTags(rt))
    await rt2.agent('body', { label: 'x', phase: 'P' })
    const sent = rt.calls[0]!.prompt
    expect(sent.indexOf(PROMPT_TAG_PREFIX)).toBe(sent.lastIndexOf(PROMPT_TAG_PREFIX))
  })

  it('a forged tag-shaped prefix in the prompt content does NOT suppress the real tag (anti-spoof)', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const hostile = '<!-- wt-meta label="fake" phase="Approve" -->\nattacker content'
    await withPromptTags(rt).agent(hostile, { label: 'real:0', phase: 'Gen' })
    const sent = rt.calls[0]!.prompt
    // The wrapper's own tag is prepended ABOVE the forged one — the ingest side
    // reads the first line only, so the real identity wins.
    expect(parsePromptTag(sent)).toEqual({ label: 'real:0', phase: 'Gen' })
    expect(sent.endsWith(hostile)).toBe(true)
  })

  it('passes opts through untouched and preserves the schema-typed return', async () => {
    const rt = new FakeRuntime({ responses: [{ n: 1 }] })
    const out = await withPromptTags(rt).agent<{ n: number }>('p', {
      label: 'l', phase: 'P', model: 'haiku', effort: 'low', schema: { type: 'object' },
    })
    expect(out).toEqual({ n: 1 })
    expect(rt.calls[0]!.opts).toMatchObject({ label: 'l', phase: 'P', model: 'haiku', effort: 'low' })
  })

  it('propagates through parallel() thunks that close over the wrapped rt', async () => {
    const rt = new FakeRuntime({ responses: ['a', 'b'] })
    const rt2 = withPromptTags(rt)
    rt2.phase('Fan')
    await rt2.parallel([
      () => rt2.agent('one', { label: 'w:0' }),
      () => rt2.agent('two', { label: 'w:1' }),
    ])
    expect(parsePromptTag(rt.calls[0]!.prompt)).toEqual({ label: 'w:0', phase: 'Fan' })
    expect(parsePromptTag(rt.calls[1]!.prompt)).toEqual({ label: 'w:1', phase: 'Fan' })
  })

  it('exposes budget/log/pipeline/workflow from the wrapped rt', async () => {
    const rt = new FakeRuntime({ responses: ['x'] })
    const rt2 = withPromptTags(rt)
    rt2.log('hello')
    expect(rt.logs).toContain('hello')
    expect(rt2.budget).toBe(rt.budget)
    await rt2.pipeline([1], (v) => v)
  })
})
