import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
// @ts-expect-error private ESM host helper
import { parseJsonc } from '../../../../plugin/bin/lib/host/jsonc.mjs'

interface Reference { raw: string, kind: string, provider: string | null, start: number, end: number, quoted: boolean }
interface LocatedReference extends Reference { expanded: string, target: string, exists: boolean, identity?: string | null }
interface ConfigSnapshot { file: string, text: string, references: LocatedReference[] }
interface CredentialsModule {
  classifyConfigReferences: (text: string, env?: Record<string, string | undefined>) => Reference[]
  sanitizeConfigReferences: (text: string, references: Reference[], remove?: (reference: Reference) => boolean) => { text: string, kept: Reference[] }
  planCredentialReferences: (configs: ConfigSnapshot[], model: string | null | undefined, env?: Record<string, string>) => { withheld: string[], missing: string[], readable: string[], copies: Array<{ inside: string, text: string }> }
}
const moduleUrl = process.env.WT_LANE_SANDBOX_TEST_LIB
  ? pathToFileURL(join(process.env.WT_LANE_SANDBOX_TEST_LIB, 'host/opencode-config-credentials.mjs'))
  : new URL('../../../../plugin/bin/lib/host/opencode-config-credentials.mjs', import.meta.url)
const { classifyConfigReferences, sanitizeConfigReferences, planCredentialReferences } = await import(moduleUrl.href) as CredentialsModule
const classify = (text: string): Reference[] => classifyConfigReferences(text)
const snapshot = (file: string, text: string, target: string, exists = true, identity: string | null = null, env: Record<string, string> = {}): ConfigSnapshot => ({ file, text, references: classifyConfigReferences(text, env).map((reference) => ({ ...reference, expanded: target, target, exists, identity })) })

describe('OpenCode global config credential references', () => {
  it.each<[string, string, string | null]>([
    ['{"agent":{"x":{"prompt":"{file:x}"}}}', 'content', null],
    ['{"template":"{file:x}"}', 'content', null],
    ['{"instructions":[["{file:x}"]]}', 'content', null],
    ['{"instructions":[{"apiKey":"{file:x}"}]}', 'credential', null],
    ['{"prompt":["{file:x}"]}', 'credential', null],
    ['{"template":[["{file:x}"]]}', 'credential', null],
    ['{"provider":{"other":{"prompt":"{file:x}"}}}', 'credential', 'other'],
    ['{"mcp":{"x":{"instructions":["{file:x}"]}}}', 'credential', null],
    ['{"mcp":{"x":{"headers":{"Authorization":"Bearer {file:x}"}}}}', 'credential', null],
    ['{"mcp":{"x":{"environment":{"KEY":"{file:x}"}}}}', 'credential', null],
    ['{"apiKey":"{file:x}"}', 'credential', null],
    ['{/* {file:x} */}', 'credential', null],
    ['{"broken": "{file:x}",', 'credential', null],
    ['{"{file:x}":"value"}', 'credential', null],
  ])('classifies the tree location in %s', (text, kind, provider) => {
    expect(classify(text)).toMatchObject([{ raw: 'x', kind, provider }])
  })

  it.each<[string, { apiKey: string }]>([
    ['{"apiKey":"{file:x}"}', { apiKey: '' }],
    ['{"apiKey":{file:x}}', { apiKey: '' }],
    ['{"apiKey":"Bearer {file:x}"}', { apiKey: 'Bearer ' }],
  ])('sanitizes token context in %s', (text, expected) => {
    expect(parseJsonc(sanitizeConfigReferences(text, classify(text)).text)).toEqual(expected)
  })
})

describe('OpenCode credential inventory planning', () => {
  it('promotes cross-config inode aliases without needing a filesystem', () => {
    const configs = [snapshot('/cfg/config.json', '{"prompt":"{file:content}"}', '/data/content', true, '2:10'), snapshot('/cfg/opencode.jsonc', '{"apiKey":"{file:key}"}', '/data/key', true, '2:10')]
    const result = planCredentialReferences(configs, 'openai/m')
    expect(result.withheld).toEqual(['/data/content', '/data/key'])
    expect(result.readable).toEqual([])
    expect(result.copies).toHaveLength(2)
  })

  it('keeps distinct content targets when device/inode identity is unavailable', () => {
    const configs = [snapshot('/cfg/config.json', '{"prompt":"{file:content}"}', '/data/content'), snapshot('/cfg/opencode.jsonc', '{"apiKey":"{file:key}"}', '/data/key')]
    expect(planCredentialReferences(configs, 'openai/m').readable).toEqual(['/data/content'])
  })

  it('separates missing credentials from withheld files and leaves missing content intact', () => {
    const configs = [snapshot('/cfg/config.json', '{"prompt":"{file:missing-content}"}', '/data/content', false), snapshot('/cfg/opencode.jsonc', '{"apiKey":{file:missing-key}}', '/data/key', false)]
    const result = planCredentialReferences(configs, 'openai/m')
    expect(result).toEqual({ withheld: [], missing: ['/data/key'], readable: [], copies: [{ inside: '/cfg/opencode.jsonc', text: '{"apiKey":""}' }] })
  })
})

describe('OpenCode credential inventory model selection', () => {
  it.each([null, undefined])('withholds credentials and sanitizes the config without a model (%s)', (model) => {
    const configs = [snapshot('/cfg/opencode.jsonc', '{"provider":{"other":{"options":{"apiKey":"{file:key}"}}}}', '/data/key')]
    expect(planCredentialReferences(configs, model)).toEqual({
      withheld: ['/data/key'], missing: [], readable: [],
      copies: [{ inside: '/cfg/opencode.jsonc', text: '{"provider":{"other":{"options":{"apiKey":""}}}}' }],
    })
  })

  it('requires a supplied model to resolve when credential references exist', () => {
    const configs = [snapshot('/cfg/config.json', '{"prompt":"{file:content}"}', '/data/content')]
    expect(planCredentialReferences(configs, null).readable).toEqual(['/data/content'])
    const credentials = [snapshot('/cfg/config.json', '{"apiKey":"{file:key}"}', '/data/key')]
    expect(() => planCredentialReferences(credentials, '{env:MODEL}', { MODEL: 'openai/m' })).not.toThrow()
    expect(() => planCredentialReferences(credentials, '{env:MODEL}', {})).toThrow(/effective model.*unresolvable/)
  })

  it('selects an unquoted config model after whole-text environment expansion', () => {
    const env = { MODEL: '"relay/m"' }
    const configs = [snapshot('/cfg/opencode.jsonc', '{"model":{env:MODEL},"provider":{"relay":{"options":{"apiKey":"{file:key}"}}}}', '/data/key', true, null, env)]
    expect(() => planCredentialReferences(configs, null, env)).toThrow(/model relay\/m .*references credential/)
  })

  it.each(['null', '123', 'false', '{}', '"invalid"', '"{env:UNKNOWN}"', ''])('refuses a present invalid expanded config model %s', (model) => {
    const configs = [snapshot('/cfg/opencode.jsonc', '{"model":{env:MODEL},"apiKey":"{file:key}"}', '/data/key')]
    expect(() => planCredentialReferences(configs, null, { MODEL: model })).toThrow(/effective model.*unresolvable/)
  })

  it('does not recursively expand environment values in a config model', () => {
    const configs = [snapshot('/cfg/opencode.jsonc', '{"model":"{env:MODEL}","apiKey":"{file:key}"}', '/data/key')]
    expect(() => planCredentialReferences(configs, null, { MODEL: '{env:PREFIX}openai/m', PREFIX: '' })).toThrow(/effective model.*unresolvable/)
  })
})

describe('OpenCode sanitized copy inventory', () => {
  it.each([
    ['environment expansion', '{env:A}{file:/private/key}{env:B}', { A: '{fi', B: 'le:/etc/lane-demo.key}' }],
    ['token deletion', '{fi{file:/private/key}le:/etc/lane-demo.key}', {}],
  ] satisfies Array<[string, string, Record<string, string>]>)('refuses a new file reference formed by %s', (_name, value, env) => {
    const text = JSON.stringify({ apiKey: value })
    const references = classifyConfigReferences(text, env).map((reference) => ({ ...reference, expanded: '/private/key', target: '/private/key', exists: true }))
    expect(() => planCredentialReferences([{ file: '/cfg/opencode.jsonc', text, references }], 'openai/m', env)).toThrow(/sanitized config \/cfg\/opencode.jsonc still references \/etc\/lane-demo\.key/)
  })

  it('retains exactly the bound content tokens and keeps environment values out of the copy', () => {
    const text = '// {file:ignored}\n{"apiKey":"{file:key}","prompt":"{file:prompt}","instructions":[["{file:guide}"]],"note":"{env:NOTE}"}'
    const env = { NOTE: 'FAKE_PRIVATE_VALUE' }
    const references = classifyConfigReferences(text, env).map((reference) => ({ ...reference, expanded: `/data/${reference.raw}`, target: `/data/${reference.raw}`, exists: true }))
    const result = planCredentialReferences([{ file: '/cfg/opencode.jsonc', text, references }], 'openai/m', env)
    expect(result.readable).toEqual(['/data/prompt', '/data/guide'])
    expect(result.copies[0]?.text).toBe(text.replace('{file:key}', ''))
    expect(result.copies[0]?.text).not.toContain('FAKE_PRIVATE_VALUE')
  })

  it('refuses a retained token whose sanitized tree location becomes credential-class', () => {
    const text = '{"pro{file:key}vider":{"other":{"prompt":"{file:prompt}"}}}'
    const references = classify(text).map((reference) => ({ ...reference, expanded: `/data/${reference.raw}`, target: `/data/${reference.raw}`, exists: true }))
    expect(() => planCredentialReferences([{ file: '/cfg/opencode.jsonc', text, references }], 'openai/m')).toThrow(/sanitized config .*still references prompt/)
  })
})

describe('OpenCode sanitized copy missing content', () => {
  it.each([true, false])('retains missing content alongside a removed credential (credential exists: %s)', (exists) => {
    const text = '{"apiKey":"{file:key}","prompt":"{file:missing-prompt}","instructions":[["{file:missing-guide}"]]}'
    const references = classify(text).map((reference) => ({ ...reference, expanded: `/data/${reference.raw}`, target: `/data/${reference.raw}`, exists: reference.kind === 'credential' && exists }))
    const result = planCredentialReferences([{ file: '/cfg/opencode.jsonc', text, references }], 'openai/m')
    expect(result).toEqual({ withheld: exists ? ['/data/key'] : [], missing: exists ? [] : ['/data/key'], readable: [], copies: [{ inside: '/cfg/opencode.jsonc', text: text.replace('{file:key}', '') }] })
  })

  it.each([
    ['environment expansion', '{env:A}{file:/private/key}{env:B}', { A: '{fi', B: 'le:/missing/assembled.key}' }],
    ['token deletion', '{fi{file:/private/key}le:/missing/assembled.key}', {}],
  ] satisfies Array<[string, string, Record<string, string>]>)('refuses a missing assembled target formed by %s', (_name, value, env) => {
    const text = JSON.stringify({ apiKey: value })
    const configs = [snapshot('/cfg/opencode.jsonc', text, '/private/key', true, null, env)]
    expect(() => planCredentialReferences(configs, 'openai/m', env)).toThrow(/sanitized config \/cfg\/opencode.jsonc still references \/missing\/assembled\.key/)
  })

  it('refuses retained missing content reclassified on the expanded sanitized tree', () => {
    const text = '{"{env:PREFIX}{file:key}vider":{"other":{"prompt":"{file:missing-prompt}"}}}'
    const env = { PREFIX: 'pro' }
    const references = classifyConfigReferences(text, env).map((reference) => ({ ...reference, expanded: `/data/${reference.raw}`, target: `/data/${reference.raw}`, exists: reference.kind === 'credential' }))
    expect(() => planCredentialReferences([{ file: '/cfg/opencode.jsonc', text, references }], 'openai/m', env)).toThrow(/sanitized config .*still references missing-prompt/)
  })
})

describe('OpenCode cleaner-owned retained inventory', () => {
  it('returns the ordered references actually kept, including duplicate and missing content', () => {
    const text = '{"apiKey":"{file:key}","prompt":"{file:prompt} {file:prompt}","instructions":["{file:missing}"]}'
    const references = classify(text)
    const result = sanitizeConfigReferences(text, references, (reference) => reference.kind === 'credential')
    expect(result.text).toBe(text.replace('{file:key}', ''))
    expect(result.kept).toEqual(references.slice(1))
  })

  it('validates the cleaner-kept existing and missing tokens as its exact output inventory', () => {
    const text = '{"apiKey":"{file:key}","prompt":"{file:prompt}","instructions":["{file:missing}"]}'
    const references = classify(text).map((reference) => ({ ...reference, expanded: `/data/${reference.raw}`, target: `/data/${reference.raw}`, exists: reference.raw !== 'missing' }))
    const result = planCredentialReferences([{ file: '/cfg/opencode.jsonc', text, references }], 'openai/m')
    expect(result.readable).toEqual(['/data/prompt'])
    expect(result.copies).toEqual([{ inside: '/cfg/opencode.jsonc', text: text.replace('{file:key}', '') }])
  })
})

describe('OpenCode substitution lexical semantics', () => {
  it.each([
    ['{"apiKey":"{env:A}{env:B}"}', { A: '{fi', B: 'le:/etc/lane-demo.key}' }],
    ['{"apiKey":"{env:A}le:/etc/lane-demo.key}"}', { A: '{fi' }],
    ['{env:COMMENT}{"apiKey":"{file:x}"}', { COMMENT: '// ' }],
    ['// {env:BREAK}{file:x}\n{}', { BREAK: '\n' }],
    ['{env:HIDE}{file:x}\n// {env:BREAK}{file:y}\n{}', { HIDE: '// ', BREAK: '\n' }],
    ['{env:HIDE}{file:x}\n// {env:BREAK}{file:y}\n{env:HIDE}{file:y}\n// {env:BREAK}{file:x}\n{}', { HIDE: '// ', BREAK: '\n' }],
    ['{env:FILES}', { FILES: '{"apiKey":"{file:x}","prompt":"{file:y}"}' }],
  ] satisfies Array<[string, Record<string, string>]>)('refuses any environment change to the ordered file inventory in %s', (text, env) => {
    expect(() => classifyConfigReferences(text, env)).toThrow(/environment substitution changes the \{file:\} references/)
  })

  it('classifies expanded keys and providers while sanitizing only the raw token offsets', () => {
    const text = '{"note":"{env:NOTE}","{env:KEY}":"Bearer {file:x}","provider":{"{env:PROVIDER}":{"prompt":"{file:y}"}}}'
    const refs = classifyConfigReferences(text, { NOTE: 'FAKE_PRIVATE_VALUE', KEY: 'apiKey', PROVIDER: 'relay' })
    expect(refs).toMatchObject([{ kind: 'credential', provider: null }, { kind: 'credential', provider: 'relay' }])
    expect(sanitizeConfigReferences(text, refs).text).toBe('{"note":"{env:NOTE}","{env:KEY}":"Bearer ","provider":{"{env:PROVIDER}":{"prompt":""}}}')
  })

  it('preserves raw quoted and unquoted contexts after environment expansion changes offsets', () => {
    const text = '{"{env:KEY}":{file:x},"note":"{env:NOTE}","apiKey":"Bearer {file:x}"}'
    const refs = classifyConfigReferences(text, { KEY: 'apiKey', NOTE: 'FAKE_PRIVATE_VALUE' })
    expect(sanitizeConfigReferences(text, refs).text).toBe('{"{env:KEY}":"","note":"{env:NOTE}","apiKey":"Bearer "}')
  })

  it('expands env over // lines before applying the file-only line skip', () => {
    expect(classifyConfigReferences('// {env:COMMENT}\n{}', { COMMENT: '{file:ignored}' })).toEqual([])
    expect(() => classifyConfigReferences('// {env:COMMENT}\n{}', { COMMENT: '\n{"apiKey":"{file:x}"}' })).toThrow(/environment.*file/)
  })

  it.each(['{"apiKey":"{env:KEY}"}', '{"prompt":"{env:KEY}"}', '{/* {env:KEY} */}', '{"x":1} // {env:KEY}'])('refuses environment-injected file substitutions in %s', (text) => {
    expect(() => classifyConfigReferences(text, { KEY: '{file:/fake/key}' })).toThrow(/environment.*file/)
  })

  it('ignores environment injection only on //-prefixed lines and permits ordinary values', () => {
    expect(classifyConfigReferences('// {env:KEY}\n{}', { KEY: '{file:/fake/key}' })).toEqual([])
    expect(classifyConfigReferences('{"apiKey":"{env:KEY}"}', { KEY: 'FAKE_VALUE' })).toEqual([])
  })
})

describe('OpenCode substitution token contexts', () => {
  it('does not confuse decoded or overwritten JSON literals with reference markers', () => {
    const direct = String.raw`{"agent":{"x":{"prompt":"\u005f_wt_file_reference_0__"}},"provider":{"other":{"options":{"apiKey":"{file:x}"}}}}`
    const overwritten = String.raw`{"{file:a}":{"prompt":"\u005f_wt_file_reference_2__"},"{file:a}":{},"apiKey":"{file:x}"}`
    expect(classify(direct)[0]?.kind).toBe('credential')
    expect(classify(overwritten).at(-1)?.kind).toBe('credential')
  })

  it('leaves //-prefixed lines untouched, but inventories inline and block comments', () => {
    const text = '// {file:skip}\n{ "x": 1, // {file:inline}\n/* {file:block} */ }'
    const refs = classify(text)
    expect(refs.map((ref) => ref.raw)).toEqual(['inline', 'block'])
    expect(sanitizeConfigReferences(text, refs).text).toContain('// {file:skip}')
  })

  it('rejects environment-dependent file paths before classification', () => {
    expect(() => classify('{"apiKey":"{file:{env:KEY_PATH}}"}')).toThrow(/environment-dependent/)
    expect(classify('// {file:{env:IGNORED}}\n{}')).toEqual([])
  })

  it('does not confuse an escaped quote, URL, or duplicate token with another location', () => {
    const text = '{"prompt":"https://x/\\\" {file:x}","apiKey":"{file:x}"}'
    expect(classify(text).map((ref) => ref.kind)).toEqual(['content', 'credential'])
    expect(parseJsonc(sanitizeConfigReferences(text, classify(text)).text)).toEqual({ prompt: 'https://x/" ', apiKey: '' })
  })

  it('refuses a sanitized copy that still cannot parse', () => {
    const text = '{"apiKey":"{file:x}", broken}'
    expect(() => sanitizeConfigReferences(text, classify(text))).toThrow(/sanitized.*parse/)
  })
})
