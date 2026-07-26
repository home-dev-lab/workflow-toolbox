import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyHealth,
  decidePortAdoption,
  decideStart,
  decideStop,
  pickStartPort,
  resolveRemoteMounts,
  slugKey,
  observeConfigRoot,
  observeServerPidfilePath,
  observeServerLogPath,
  observeStateRoot,
  parseSysctlBoottimeSec,
  parsePsLstartEpochSec,
  parsePowershellInt,
  normalizeRemoteUrl,
  parseConfigAction,
  parseObserveRemotesEnv,
  planRemoteMounts,
  parseObservePidfile,
  remoteKeyForUrl,
  resolveHubSources,
  serializeObservePidfile,
  withCarriedToken,
  type ObservePidfile,
} from '../src/observe-lifecycle.js'

// The pure brain of the `wt-observe` lifecycle CLI (start|stop|status). Every branch the
// red-team flagged is a named decision here, unit-tested with injected probe results:
//  - adopt is decided on HEALTH IDENTITY (a validly-shaped observe-ui payload — see
//    classifyHealth), never on "some process answers on the port";
//  - a pid-alive/port-dead pidfile is a ZOMBIE (owned, wedged) → kill-zombie, never adopt;
//  - a dead pid or a PID-IDENTITY mismatch (boot-id/start-ticks — PID reuse after reboot
//    or recycle) means the pidfile is STALE → clear it, NEVER signal the innocent process.

const PF: ObservePidfile = {
  pid: 4242,
  port: 5174,
  configDir: '/home/u/.claude',
  bootId: 'boot-abc',
  procStartTicks: 111,
  startedAt: '2026-07-02T09:00:00Z',
  sources: ['/home/u/.claude'],
}

describe('observeStateRoot / observeServerPidfilePath', () => {
  it('defaults the state root to ~/.local/state/wt-observe on linux (config-dir-INDEPENDENT)', () => {
    expect(observeStateRoot({}, '/home/u', 'linux')).toBe(join('/home/u', '.local', 'state', 'wt-observe'))
  })

  it('honours XDG_STATE_HOME', () => {
    expect(observeStateRoot({ XDG_STATE_HOME: '/xdg/state' }, '/home/u', 'linux')).toBe(join('/xdg/state', 'wt-observe'))
  })

  // Cross-OS natives (card #1813359570421023938): macOS Application Support for state,
  // Windows %LOCALAPPDATA% (local, non-roaming — state is machine-bound: pidfile, logs).
  it('darwin: state root is ~/Library/Application Support/wt-observe', () => {
    expect(observeStateRoot({}, '/Users/u', 'darwin'))
      .toBe(join('/Users/u', 'Library', 'Application Support', 'wt-observe'))
  })

  it('win32: state root is %LOCALAPPDATA%/wt-observe, falling back to ~/AppData/Local', () => {
    expect(observeStateRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', 'win32'))
      .toBe(join('C:\\Users\\u\\AppData\\Local', 'wt-observe'))
    expect(observeStateRoot({}, 'C:\\Users\\u', 'win32'))
      .toBe(join('C:\\Users\\u', 'AppData', 'Local', 'wt-observe'))
  })

  // An EXPLICITLY set XDG var is explicit user intent — it wins on every platform
  // (unlike env-paths, which ignores XDG off-Linux and would surprise that user).
  it('an explicit XDG_STATE_HOME wins even on darwin/win32', () => {
    expect(observeStateRoot({ XDG_STATE_HOME: '/xdg/state' }, '/Users/u', 'darwin')).toBe(join('/xdg/state', 'wt-observe'))
    expect(observeStateRoot({ XDG_STATE_HOME: '/xdg/state' }, 'C:\\Users\\u', 'win32')).toBe(join('/xdg/state', 'wt-observe'))
  })

  // Verb unification: ONE observe server per user (not keyed by any single configDir, since
  // it serves 1+ resolved sources) — a literal 'server.json' filename under the
  // config-dir-independent state root, so a second `wt-observe start` (whatever it resolves)
  // adopts the SAME running server rather than minting a second pidfile.
  it('observeServerPidfilePath is a literal "server.json" under the state root — never a configDirKey', () => {
    const root = '/state/wt-observe'
    expect(observeServerPidfilePath(root)).toBe(join(root, 'server.json'))
  })

  it('observeServerLogPath is a literal "server.log" under the state root, paired with the pidfile', () => {
    const root = '/state/wt-observe'
    expect(observeServerLogPath(root)).toBe(join(root, 'server.log'))
  })
})

// The hub's persistent, config-dir-INDEPENDENT source list lives under its own config root
// — mirrors observeStateRoot's own XDG formula exactly, since (like the state root) it spans
// several config dirs and cannot live inside any one of them.
describe('observeConfigRoot', () => {
  it('defaults the config root to ~/.config/wt-observe on linux (config-dir-INDEPENDENT)', () => {
    expect(observeConfigRoot({}, '/home/u', 'linux')).toBe(join('/home/u', '.config', 'wt-observe'))
  })

  it('honours XDG_CONFIG_HOME', () => {
    expect(observeConfigRoot({ XDG_CONFIG_HOME: '/xdg/config' }, '/home/u', 'linux')).toBe(join('/xdg/config', 'wt-observe'))
  })

  // Cross-OS natives: macOS Preferences for config, Windows %APPDATA% (roaming — a
  // user-authored source list should follow the user profile).
  it('darwin: config root is ~/Library/Preferences/wt-observe', () => {
    expect(observeConfigRoot({}, '/Users/u', 'darwin'))
      .toBe(join('/Users/u', 'Library', 'Preferences', 'wt-observe'))
  })

  it('win32: config root is %APPDATA%/wt-observe, falling back to ~/AppData/Roaming', () => {
    expect(observeConfigRoot({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u', 'win32'))
      .toBe(join('C:\\Users\\u\\AppData\\Roaming', 'wt-observe'))
    expect(observeConfigRoot({}, 'C:\\Users\\u', 'win32'))
      .toBe(join('C:\\Users\\u', 'AppData', 'Roaming', 'wt-observe'))
  })

  it('an explicit XDG_CONFIG_HOME wins even on darwin/win32', () => {
    expect(observeConfigRoot({ XDG_CONFIG_HOME: '/xdg/config' }, '/Users/u', 'darwin')).toBe(join('/xdg/config', 'wt-observe'))
    expect(observeConfigRoot({ XDG_CONFIG_HOME: '/xdg/config' }, 'C:\\Users\\u', 'win32')).toBe(join('/xdg/config', 'wt-observe'))
  })
})

// Cross-OS PID identity (card #1813359570421023938): the impure per-OS probes live in
// observe-cli; THESE are their pure output parsers. Identity equality never compares
// across platforms, so each parser only needs a stable value on its own OS.
describe('per-OS identity parsers', () => {
  it('parseSysctlBoottimeSec extracts sec from macOS kern.boottime output', () => {
    expect(parseSysctlBoottimeSec('{ sec = 1751970002, usec = 123456 } Tue Jul  8 07:00:02 2026\n'))
      .toBe(1751970002)
  })

  it('parseSysctlBoottimeSec returns null on garbage/empty', () => {
    expect(parseSysctlBoottimeSec('')).toBeNull()
    expect(parseSysctlBoottimeSec('sysctl: unknown oid')).toBeNull()
  })

  it('parsePsLstartEpochSec parses ps -o lstart= (incl. the double-space single-digit day)', () => {
    const out = parsePsLstartEpochSec('Tue Jul  8 07:30:02 2026\n')
    expect(out).toBe(Math.floor(new Date('Jul 8 2026 07:30:02').getTime() / 1000))
  })

  it('parsePsLstartEpochSec returns null on garbage/empty', () => {
    expect(parsePsLstartEpochSec('')).toBeNull()
    expect(parsePsLstartEpochSec('ps: no such process')).toBeNull()
  })

  it('parsePowershellInt parses a PowerShell integer line (CRLF-tolerant) — used for ToUnixTimeSeconds() outputs', () => {
    expect(parsePowershellInt('1751970002\r\n')).toBe(1751970002)
  })

  it('parsePowershellInt returns null on garbage/empty/non-numeric', () => {
    expect(parsePowershellInt('')).toBeNull()
    expect(parsePowershellInt('Get-Process : Cannot find a process')).toBeNull()
  })
})

describe('pidfile parse/serialize', () => {
  it('round-trips a full pidfile', () => {
    expect(parseObservePidfile(serializeObservePidfile(PF))).toEqual(PF)
  })

  it('rejects malformed JSON and missing required fields', () => {
    expect(parseObservePidfile('{ not json')).toBeNull()
    expect(parseObservePidfile(JSON.stringify({ pid: 1 }))).toBeNull()
    expect(parseObservePidfile(JSON.stringify({ ...PF, port: 'nope' }))).toBeNull()
  })

  it('tolerates null identity fields (recorded best-effort on non-Linux)', () => {
    const pf = { ...PF, bootId: null, procStartTicks: null }
    expect(parseObservePidfile(serializeObservePidfile(pf))).toEqual(pf)
  })

  // Verb unification: `sources` is now REQUIRED (every pidfile this CLI writes goes
  // through the same resolved-source path, single-source included — no retro-compat with
  // a pre-unification pidfile shape is required).
  it('round-trips a multi-source pidfile', () => {
    const multi: ObservePidfile = { ...PF, sources: ['/home/u/.claude', '/home/u/.claude-work'] }
    expect(parseObservePidfile(serializeObservePidfile(multi))).toEqual(multi)
  })

  it('rejects a pidfile missing `sources`, or with an empty/non-string-array `sources`', () => {
    const noSources = Object.fromEntries(Object.entries(PF).filter(([k]) => k !== 'sources'))
    expect(parseObservePidfile(JSON.stringify(noSources))).toBeNull()
    expect(parseObservePidfile(JSON.stringify({ ...PF, sources: [] }))).toBeNull()
    expect(parseObservePidfile(JSON.stringify({ ...PF, sources: 'nope' }))).toBeNull()
    expect(parseObservePidfile(JSON.stringify({ ...PF, sources: [1, 2] }))).toBeNull()
  })
})

// multi-observe I5 (+ config-file/glob follow-up) — resolveHubSources decides WHICH config
// dirs `wt-observe hub start` mounts. Pure: `exists`/`canonicalize` are injected (real
// fs.existsSync / resolveDir from the CLI), and the three candidate lists (explicit,
// configSources, discoveryCandidates) are ALSO gathered by the impure CLI layer (flag
// parsing, readObserveConfig, discoverConfigDirCandidates) — so every precedence branch here
// is testable with plain literals, no fs/env/home access inside this function at all.
describe('resolveHubSources', () => {
  // `canonicalize` (I5-review fix) is injected exactly like `exists`. Identity here keeps the
  // non-canonicalization expectations simple; the canonicalization tests use a real-ish
  // normalizer (trailing-slash strip) to pin the collapse that plain-string dedup would miss.
  const identity = (p: string) => p

  it('explicit --source flags WIN outright — used as-is, deduped, NOT filtered by existence (the caller validates that separately)', () => {
    const exists = () => false // even if nothing "exists", explicit flags still win
    expect(resolveHubSources(['/a', '/b', '/a'], [], [], exists, identity)).toEqual(['/a', '/b'])
  })

  it('explicit flags win even when BOTH config-file sources and discovery candidates are non-empty', () => {
    const exists = () => true
    expect(resolveHubSources(['/a', '/b'], ['/config/one'], ['/discovered/one'], exists, identity)).toEqual(['/a', '/b'])
  })

  it('no explicit flags: config-file sources WIN over discovery — canonicalized + filtered by existence + deduped', () => {
    const existing = new Set(['/config/one', '/config/two'])
    const exists = (p: string) => existing.has(p)
    expect(
      resolveHubSources([], ['/config/one', '/config/two', '/config/one'], ['/discovered/a', '/discovered/b'], exists, identity),
    ).toEqual(['/config/one', '/config/two'])
  })

  it('config-file sources SHORT-CIRCUIT discovery even when they resolve to fewer than 2 existing dirs — the <2-refuses decision is the CALLER\'s, not this function\'s', () => {
    // /config/missing doesn't exist; the discovery candidates below would satisfy 2+ on their
    // own, but a non-empty config-file source list must still win outright over discovery.
    const exists = (p: string) => p === '/config/one'
    expect(resolveHubSources([], ['/config/one', '/config/missing'], ['/discovered/a', '/discovered/b'], exists, identity)).toEqual([
      '/config/one',
    ])
  })

  it('canonicalizes config-file sources before deduping — two spellings of one dir collapse', () => {
    const canon = (p: string) => p.replace(/\/+$/, '')
    const exists = () => true
    expect(resolveHubSources([], ['/config/one/', '/config/one'], [], exists, canon)).toEqual(['/config/one'])
  })

  it('falls back to discovery candidates when explicit flags AND config-file sources are both empty', () => {
    const existing = new Set(['/home/u/.claude', '/home/u/.claude-work'])
    const exists = (p: string) => existing.has(p)
    expect(resolveHubSources([], [], ['/home/u/.claude', '/home/u/.claude-work'], exists, identity)).toEqual([
      '/home/u/.claude',
      '/home/u/.claude-work',
    ])
  })

  it('drops a discovery candidate that does not exist', () => {
    const exists = (p: string) => p === '/home/u/.claude' // .claude-work absent on this machine
    expect(resolveHubSources([], [], ['/home/u/.claude', '/home/u/.claude-work'], exists, identity)).toEqual(['/home/u/.claude'])
  })

  it('dedups discovery candidates (e.g. $CLAUDE_CONFIG_DIR happens to equal ~/.claude, byte-identical string)', () => {
    const existing = new Set(['/home/u/.claude', '/home/u/.claude-work'])
    const exists = (p: string) => existing.has(p)
    expect(resolveHubSources([], [], ['/home/u/.claude', '/home/u/.claude', '/home/u/.claude-work'], exists, identity)).toEqual([
      '/home/u/.claude',
      '/home/u/.claude-work',
    ])
  })

  it('returns fewer than 2 (even 0) when discovery finds fewer — the <2-refuses decision is the CALLER\'s, not this function\'s', () => {
    expect(resolveHubSources([], [], ['/home/u/.claude', '/home/u/.claude-work'], () => false, identity)).toEqual([])
  })

  // The codex/sonnet I5-review bug: a same-real-dir spelling ($CLAUDE_CONFIG_DIR with a
  // trailing slash / symlink / relative form) is a DISTINCT string from another spelling of
  // the same dir, so plain dedup kept both → the CLI counted 2, passed its <2 check, but the
  // server canonicalized to 1 and booted single-source → hub-readiness timeout.
  // Canonicalizing BEFORE dedup fixes it.
  it('canonicalizes discovery candidates before deduping — a trailing-slash spelling collapses onto another spelling of the same dir', () => {
    const canon = (p: string) => p.replace(/\/+$/, '') // resolveDir stand-in (strip trailing slash)
    const exists = () => true
    expect(
      resolveHubSources([], [], ['/home/u/.claude/', '/home/u/.claude', '/home/u/.claude-work'], exists, canon),
    ).toEqual(['/home/u/.claude', '/home/u/.claude-work'])
  })

  it('canonicalizes explicit --source flags before deduping too — two spellings of one dir collapse', () => {
    const canon = (p: string) => p.replace(/\/+$/, '')
    expect(resolveHubSources(['/a/', '/a', '/b'], [], [], () => false, canon)).toEqual(['/a', '/b'])
  })
})

describe('decideStart', () => {
  it('no pidfile + default port silent → start on the default port', () => {
    expect(decideStart({ pidfile: null, pidAlive: false, pidIdentityMatches: false, health: 'unreachable' }))
      .toEqual({ action: 'start' })
  })

  it('no pidfile + a server on the port that IS ours (health identity) → adopt (re-own, rewrite pidfile)', () => {
    expect(decideStart({ pidfile: null, pidAlive: false, pidIdentityMatches: false, health: 'ours' }))
      .toEqual({ action: 'adopt' })
  })

  it('no pidfile + a FOREIGN process on the port → start on a probed free port, never touch it', () => {
    expect(decideStart({ pidfile: null, pidAlive: false, pidIdentityMatches: false, health: 'foreign' }))
      .toEqual({ action: 'start-free-port' })
  })

  it('pidfile + pid alive + identity match + health ours → adopt', () => {
    expect(decideStart({ pidfile: PF, pidAlive: true, pidIdentityMatches: true, health: 'ours' }))
      .toEqual({ action: 'adopt' })
  })

  it('ZOMBIE: pidfile + pid alive + identity match but port unreachable → kill-zombie (owned, wedged)', () => {
    expect(decideStart({ pidfile: PF, pidAlive: true, pidIdentityMatches: true, health: 'unreachable' }))
      .toEqual({ action: 'kill-zombie', pid: PF.pid })
  })

  it('pid alive + identity match but a FOREIGN server owns the port → kill-zombie (ours is wedged unbound)', () => {
    expect(decideStart({ pidfile: PF, pidAlive: true, pidIdentityMatches: true, health: 'foreign' }))
      .toEqual({ action: 'kill-zombie', pid: PF.pid })
  })

  it('INCONCLUSIVE health (timeout — maybe just busy) + owned alive server → retry-health, NEVER kill', () => {
    expect(decideStart({ pidfile: PF, pidAlive: true, pidIdentityMatches: true, health: 'inconclusive' }))
      .toEqual({ action: 'retry-health' })
  })

  it('INCONCLUSIVE health with no pidfile → start on a free port (never bind-fight, never adopt a guess)', () => {
    expect(decideStart({ pidfile: null, pidAlive: false, pidIdentityMatches: false, health: 'inconclusive' }))
      .toEqual({ action: 'start-free-port' })
  })

  it('PID-REUSE guard: pid alive but identity MISMATCH → clear-stale, never kill the innocent pid', () => {
    expect(decideStart({ pidfile: PF, pidAlive: true, pidIdentityMatches: false, health: 'unreachable' }))
      .toEqual({ action: 'clear-stale' })
  })

  it('pid dead (reboot/crash) → clear-stale', () => {
    expect(decideStart({ pidfile: PF, pidAlive: false, pidIdentityMatches: false, health: 'unreachable' }))
      .toEqual({ action: 'clear-stale' })
  })
})

describe('decideStop', () => {
  it('no pidfile → noop', () => {
    expect(decideStop({ pidfile: null, pidAlive: false, pidIdentityMatches: false })).toEqual({ action: 'noop' })
  })

  it('pid dead → clear the stale pidfile, nothing to signal', () => {
    expect(decideStop({ pidfile: PF, pidAlive: false, pidIdentityMatches: false })).toEqual({ action: 'clear' })
  })

  it('PID-REUSE guard: pid alive but identity mismatch → clear, NEVER SIGTERM the innocent process', () => {
    expect(decideStop({ pidfile: PF, pidAlive: true, pidIdentityMatches: false })).toEqual({ action: 'clear' })
  })

  it('pid alive + identity match → kill (SIGTERM) then clear', () => {
    expect(decideStop({ pidfile: PF, pidAlive: true, pidIdentityMatches: true })).toEqual({ action: 'kill', pid: PF.pid })
  })
})

describe('withCarriedToken', () => {
  const prior: ObservePidfile = { ...PF, token: 'tok-prior-0123456789abcdef' }

  it('carries the prior token into a health-rebuilt pidfile (the adopt path)', () => {
    expect(withCarriedToken(PF, prior)).toEqual({ ...PF, token: 'tok-prior-0123456789abcdef' })
  })

  it('never overwrites a token the next pidfile already has (the fresh-spawn path)', () => {
    const next = { ...PF, token: 'tok-fresh-0123456789abcdef' }
    expect(withCarriedToken(next, prior)).toEqual(next)
  })

  it('no prior / prior without token → unchanged (first-ever start, pre-token pidfiles)', () => {
    expect(withCarriedToken(PF, null)).toEqual(PF)
    expect(withCarriedToken(PF, { ...PF })).toEqual(PF)
  })

  it('token round-trips through serialize/parse (the 0600 pidfile is the out-of-browser copy)', () => {
    const carried = withCarriedToken(PF, prior)
    expect(parseObservePidfile(serializeObservePidfile(carried))).toEqual(carried)
  })
})

// Verb unification: ONE classifier replaces the old per-config-dir classifyHealth AND the
// hub's classifyHubHealth. It no longer takes the resolved config dir / source set at all —
// see its own doc comment for why (ownership no longer means "the served set equals what
// was just freshly resolved"; that's the DRIFT TOLERANCE these tests pin).
describe('classifyHealth', () => {
  it('no-listener → unreachable; not-ours → foreign; timeout → inconclusive', () => {
    expect(classifyHealth('no-listener')).toBe('unreachable')
    expect(classifyHealth('not-ours')).toBe('foreign')
    expect(classifyHealth('timeout')).toBe('inconclusive')
  })

  it('a 1-element-set health payload (configDir shape) → ours', () => {
    expect(classifyHealth({ configDir: '/home/u/.claude' })).toBe('ours')
  })

  it('an N-element-set health payload (sources[] shape) → ours', () => {
    expect(classifyHealth({ sources: [{ key: 'a', configDir: '/home/u/.claude' }, { key: 'b', configDir: '/home/u/.claude-work' }] })).toBe(
      'ours',
    )
  })

  it('DRIFT TOLERANCE: a configDir payload naming a DIFFERENT dir than whatever the caller just resolved is still ours — set drift is not a "foreign" verdict', () => {
    // classifyHealth takes no resolved-set argument at all: there is nothing to compare
    // against, by design — the caller cannot even ask "does this match what I resolved".
    expect(classifyHealth({ configDir: '/home/u/.claude-work' })).toBe('ours')
  })

  it('DRIFT TOLERANCE: an N-source payload whose served sources differ from a fresh re-resolution is still ours', () => {
    expect(classifyHealth({ sources: [{ key: 'z', configDir: '/some/other/dir' }] })).toBe('ours')
  })
})

// The `wt-observe config` verb's arg parsing — pure, so every branch is a plain-literal
// test (the fs read/write it drives lives in observe-config.ts, tested there).
describe('parseConfigAction', () => {
  it('no sub-action, or "show" → { action: "show" } (the default, same posture as the bare top-level command defaulting to status)', () => {
    expect(parseConfigAction([])).toEqual({ action: 'show' })
    expect(parseConfigAction(['show'])).toEqual({ action: 'show' })
  })

  it('"add-source <dir>" → { action: "add-source", dir }', () => {
    expect(parseConfigAction(['add-source', '/home/u/.claude-work'])).toEqual({ action: 'add-source', dir: '/home/u/.claude-work' })
  })

  it('"remove-source <dir>" → { action: "remove-source", dir }', () => {
    expect(parseConfigAction(['remove-source', '/home/u/.claude-work'])).toEqual({ action: 'remove-source', dir: '/home/u/.claude-work' })
  })

  it('"add-source"/"remove-source" with no dir → invalid, usage message', () => {
    expect(parseConfigAction(['add-source'])).toEqual({ action: 'invalid', message: 'usage: wt-observe config add-source <dir>' })
    expect(parseConfigAction(['remove-source'])).toEqual({ action: 'invalid', message: 'usage: wt-observe config remove-source <dir>' })
  })

  it('an unknown sub-action → invalid, names the unrecognized word', () => {
    expect(parseConfigAction(['bogus'])).toEqual({
      action: 'invalid',
      message: 'unknown `wt-observe config` action "bogus" (expected show|add-source|remove-source|add-remote|remove-remote)',
    })
  })
})

// Hub federation — remote-hub entries share the same config file; the parse layer stays
// pure (flags → fields), fs/URL-validation live with the CLI command + normalizeRemoteUrl.
describe('parseConfigAction — add-remote / remove-remote', () => {
  it('"add-remote <url>" → { action: "add-remote", url } (credentials optional at parse time)', () => {
    expect(parseConfigAction(['add-remote', 'http://localhost:5174'])).toEqual({ action: 'add-remote', url: 'http://localhost:5174' })
  })

  it('"add-remote <url> --token <t> | --token-file <p> | --label <l>" carries each flag through', () => {
    expect(parseConfigAction(['add-remote', 'http://localhost:5174', '--token', 'tok_abc'])).toEqual({
      action: 'add-remote',
      url: 'http://localhost:5174',
      token: 'tok_abc',
    })
    expect(parseConfigAction(['add-remote', 'http://localhost:5174', '--token-file', '/state/server.json', '--label', 'wsl'])).toEqual({
      action: 'add-remote',
      url: 'http://localhost:5174',
      tokenFile: '/state/server.json',
      label: 'wsl',
    })
  })

  it('"add-remote" rejects: missing url, --token AND --token-file together, a flag with no value, an unknown flag', () => {
    expect(parseConfigAction(['add-remote'])).toEqual({
      action: 'invalid',
      message: 'usage: wt-observe config add-remote <url> [--token <t> | --token-file <path>] [--label <label>]',
    })
    expect(parseConfigAction(['add-remote', 'http://a:1', '--token', 't', '--token-file', '/p'])).toEqual({
      action: 'invalid',
      message: 'config add-remote: pass --token OR --token-file, not both',
    })
    expect(parseConfigAction(['add-remote', 'http://a:1', '--token'])).toEqual({
      action: 'invalid',
      message: 'config add-remote: --token requires a value',
    })
    expect(parseConfigAction(['add-remote', 'http://a:1', '--bogus', 'x'])).toEqual({
      action: 'invalid',
      message: 'config add-remote: unknown flag "--bogus"',
    })
  })

  it('"remove-remote <url>" → { action: "remove-remote", url }; missing url → usage', () => {
    expect(parseConfigAction(['remove-remote', 'http://localhost:5174'])).toEqual({ action: 'remove-remote', url: 'http://localhost:5174' })
    expect(parseConfigAction(['remove-remote'])).toEqual({ action: 'invalid', message: 'usage: wt-observe config remove-remote <url>' })
  })
})

// ── remote-URL helpers (hub federation) — pure, shared by the CLI (add/remove-remote,
// start plumbing) and the server side (dev-api parses OBSERVE_REMOTES with the same
// normalization, so "same remote" means the same thing on both sides). ────────
describe('normalizeRemoteUrl', () => {
  it('accepts http/https and returns origin + path without a trailing slash', () => {
    expect(normalizeRemoteUrl('http://localhost:5174')).toBe('http://localhost:5174')
    expect(normalizeRemoteUrl('http://localhost:5174/')).toBe('http://localhost:5174')
    expect(normalizeRemoteUrl('https://devbox:8443/observe/')).toBe('https://devbox:8443/observe')
  })

  it('canonicalizes case/default-port spellings via the URL parser (two spellings of the same origin compare equal)', () => {
    expect(normalizeRemoteUrl('HTTP://LOCALHOST:5174')).toBe('http://localhost:5174')
    expect(normalizeRemoteUrl('http://example.com:80/')).toBe('http://example.com')
  })

  it('drops query and hash — a remote hub origin never carries them, and keeping them would make dedupe/removal spelling-sensitive', () => {
    expect(normalizeRemoteUrl('http://localhost:5174/?token=x#frag')).toBe('http://localhost:5174')
  })

  it('rejects non-http(s) schemes and unparseable strings with null', () => {
    expect(normalizeRemoteUrl('ftp://x')).toBeNull()
    expect(normalizeRemoteUrl('not a url')).toBeNull()
    expect(normalizeRemoteUrl('')).toBeNull()
    expect(normalizeRemoteUrl('file:///etc/passwd')).toBeNull()
  })
})

describe('remoteKeyForUrl', () => {
  it('derives a /s/<key>-safe slug: "remote-" + host[-port][-path], non-alnum runs collapsed to "-"', () => {
    expect(remoteKeyForUrl('http://localhost:5174')).toBe('remote-localhost-5174')
    expect(remoteKeyForUrl('https://devbox:8443/observe')).toBe('remote-devbox-8443-observe')
    expect(remoteKeyForUrl('http://example.com')).toBe('remote-example-com')
  })

  it('never emits characters outside [a-z0-9-] (the SOURCE_PREFIX route segment contract), IPv6 included', () => {
    const key = remoteKeyForUrl('http://[::1]:5174')
    expect(key).toMatch(/^remote-[a-z0-9-]+$/)
    expect(key).toBe('remote-1-5174')
  })
})

describe('parseObserveRemotesEnv', () => {
  it('unset/blank → no remotes, no notes', () => {
    expect(parseObserveRemotesEnv(undefined)).toEqual({ remotes: [], dropped: [] })
    expect(parseObserveRemotesEnv('  ')).toEqual({ remotes: [], dropped: [] })
  })

  it('parses entries, canonicalizes URLs, derives keys, keeps credentials/label', () => {
    const raw = JSON.stringify([
      { url: 'http://localhost:5174/', tokenFile: '/state/server.json', label: 'wsl' },
      { url: 'HTTP://DEVBOX:8443' },
    ])
    expect(parseObserveRemotesEnv(raw)).toEqual({
      remotes: [
        { key: 'remote-localhost-5174', url: 'http://localhost:5174', tokenFile: '/state/server.json', label: 'wsl' },
        { key: 'remote-devbox-8443', url: 'http://devbox:8443' },
      ],
      dropped: [],
    })
  })

  it('degrades per entry with a note — malformed JSON, non-array, non-object entries, unusable urls — never throws', () => {
    expect(parseObserveRemotesEnv('{ not json').remotes).toEqual([])
    expect(parseObserveRemotesEnv('{ not json').dropped).toHaveLength(1)
    expect(parseObserveRemotesEnv('"a string"').dropped).toHaveLength(1)
    const mixed = parseObserveRemotesEnv(JSON.stringify([{ url: 'http://a:1' }, 42, { url: 'ftp://x' }, { token: 't' }]))
    expect(mixed.remotes).toEqual([{ key: 'remote-a-1', url: 'http://a:1' }])
    expect(mixed.dropped).toHaveLength(3)
  })

  it('dedupes by derived key, first entry wins (two spellings of one origin collapse)', () => {
    const raw = JSON.stringify([
      { url: 'http://localhost:5174', label: 'first' },
      { url: 'http://LOCALHOST:5174/', label: 'second' },
    ])
    const out = parseObserveRemotesEnv(raw)
    expect(out.remotes).toEqual([{ key: 'remote-localhost-5174', url: 'http://localhost:5174', label: 'first' }])
    expect(out.dropped).toHaveLength(1)
  })
})

describe('planRemoteMounts', () => {
  const remote = { key: 'remote-localhost-5174', url: 'http://localhost:5174', tokenFile: '/state/server.json', label: 'wsl' }

  it('probe failed (null/undefined/non-object) → ONE flattened mount, entry untouched', () => {
    expect(planRemoteMounts(remote, null)).toEqual([remote])
    expect(planRemoteMounts(remote, undefined)).toEqual([remote])
    expect(planRemoteMounts(remote, 'down')).toEqual([remote])
  })

  it('single-source health (configDir shape, no sources[]) → ONE flattened mount', () => {
    expect(planRemoteMounts(remote, { app: 'observe-ui', configDir: '/home/u/.claude' })).toEqual([remote])
  })

  it('hub health → one mount per remote-LOCAL source under /s/<subkey>, credentials inherited, labels composed cross-OS', () => {
    const health = {
      app: 'observe-ui',
      sources: [
        { key: 'claude-key', configDir: '/home/u/.claude' },
        { key: 'work-key', configDir: 'C:\\Users\\u\\.claude-work' },
      ],
    }
    expect(planRemoteMounts(remote, health)).toEqual([
      {
        key: 'remote-localhost-5174-claude-key',
        url: 'http://localhost:5174',
        pathPrefix: '/s/claude-key',
        label: 'wsl · .claude',
        tokenFile: '/state/server.json',
      },
      {
        key: 'remote-localhost-5174-work-key',
        url: 'http://localhost:5174',
        pathPrefix: '/s/work-key',
        label: 'wsl · .claude-work',
        tokenFile: '/state/server.json',
      },
    ])
  })

  it("SKIPS the remote's own remote:true entries (federation depth is 1 — no transitive chains, no loops)", () => {
    const health = {
      sources: [
        { key: 'local-key', configDir: '/home/u/.claude' },
        { key: 'remote-far-1', url: 'http://far:1', remote: true },
      ],
    }
    const mounts = planRemoteMounts(remote, health)
    expect(mounts).toHaveLength(1)
    expect(mounts[0]!.key).toBe('remote-localhost-5174-local-key')
  })

  it('hub health whose sources are ALL remote → flattened fallback (never zero mounts)', () => {
    const health = { sources: [{ key: 'remote-far-1', url: 'http://far:1', remote: true }] }
    expect(planRemoteMounts(remote, health)).toEqual([remote])
  })

  it("keeps a valid sub-key VERBATIM in the pathPrefix (it must byte-match the remote's own /s/<key> route)", () => {
    // Regression guard (2026-07-09, shipped then caught live): slug-collapsing a real
    // configDirKey like '-home-u--claude-c358fa78' (leading + double dash) to
    // 'home-u-claude-c358fa78' made every forwarded request 404 → "server unreachable".
    const health = { sources: [{ key: '-home-u--claude-c358fa78', configDir: '/home/u/.claude' }] }
    const mounts = planRemoteMounts(remote, health)
    expect(mounts).toHaveLength(1)
    expect(mounts[0]!.pathPrefix).toBe('/s/-home-u--claude-c358fa78') // VERBATIM, not collapsed
    expect(mounts[0]!.key).toBe('remote-localhost-5174--home-u--claude-c358fa78')
  })

  it("DROPS a sub-source whose key isn't route-safe ([a-z0-9-]) — never mangles it or forwards it", () => {
    const health = {
      sources: [
        { key: 'Weird Key/../x', configDir: '/home/u/.claude' }, // unsafe → dropped (can't be a real route; unsafe to splice)
        { key: 'good-key', configDir: '/home/u/.claude2' },
      ],
    }
    const mounts = planRemoteMounts(remote, health)
    expect(mounts.map((m) => m.pathPrefix)).toEqual(['/s/good-key']) // only the safe one survives
  })
})

describe('slugKey', () => {
  it('collapses to [a-z0-9-], lowercased and trimmed', () => {
    expect(slugKey('Weird Key/../x')).toBe('weird-key-x')
    expect(slugKey('.claude-work')).toBe('claude-work')
    expect(slugKey('---A_B.C---')).toBe('a-b-c')
    expect(slugKey('!!!')).toBe('')
  })
})

describe('pickStartPort (federation-aware)', () => {
  const r = (url: string) => ({ key: 'k', url })
  it('keeps the preferred port when no remote clashes with it on loopback', () => {
    expect(pickStartPort(5174, [])).toBe(5174)
    expect(pickStartPort(5174, [r('http://devbox:5174')])).toBe(5174) // non-loopback host, no shadow
    expect(pickStartPort(5174, [r('http://localhost:9999')])).toBe(5174) // loopback, different port
  })
  it('bumps to preferred+1 when a loopback remote claims the preferred port (self-federation guard)', () => {
    expect(pickStartPort(5174, [r('http://localhost:5174')])).toBe(5175)
    expect(pickStartPort(5174, [r('http://127.0.0.1:5174')])).toBe(5175)
  })
})

describe('decidePortAdoption (EADDRINUSE arbitration — pidfile is the trust anchor)', () => {
  const pf = (over: Partial<{ port: number; sources: string[]; configDir: string }> = {}) => ({
    pid: 1, port: 5174, configDir: '/home/u/.claude', bootId: null, procStartTicks: null, startedAt: 'x', sources: ['/home/u/.claude'], ...over,
  })
  const wanted = ['/home/u/.claude']

  it('HIGH fix: a TIMEOUT on OUR pidfile-owned port ADOPTS (never foreign/ephemeral)', () => {
    // health===null = no answer within the timeout on a busy-but-healthy server. The old code
    // called this "foreign" and spun a pidfile-hijacking ephemeral. Now: adopt (pidfile authenticates).
    const d = decidePortAdoption({ port: 5174, health: null, pidfile: pf(), wanted })
    expect(d).toEqual({ kind: 'adopt', served: ['/home/u/.claude'], mismatch: false })
  })

  it('adopts our server and flags a served-set mismatch when health answers with a different set', () => {
    const health = { app: 'observe-ui', sources: [{ configDir: '/home/u/.claude-work' }] }
    const d = decidePortAdoption({ port: 5174, health, pidfile: pf(), wanted })
    expect(d.kind).toBe('adopt')
    if (d.kind === 'adopt') {
      expect(d.served).toEqual(['/home/u/.claude-work'])
      expect(d.mismatch).toBe(true)
    }
  })

  it('#2: an observe-ui health WITHOUT a corroborating pidfile → ephemeral (never trust the spoofable flag)', () => {
    const health = { app: 'observe-ui', sources: [{ configDir: '/home/u/.claude' }] }
    // pidfile records a DIFFERENT port → this port is not authenticated as ours.
    expect(decidePortAdoption({ port: 5174, health, pidfile: pf({ port: 5999 }), wanted })).toEqual({ kind: 'ephemeral', reason: 'unauthenticated-observe' })
    // no pidfile at all → ephemeral too.
    expect(decidePortAdoption({ port: 5174, health, pidfile: null, wanted })).toEqual({ kind: 'ephemeral', reason: 'unauthenticated-observe' })
  })

  it('a genuinely foreign server on the port → ephemeral(foreign); a timeout with no pidfile → ephemeral(inconclusive)', () => {
    expect(decidePortAdoption({ port: 5174, health: { app: 'something-else' }, pidfile: null, wanted })).toEqual({ kind: 'ephemeral', reason: 'foreign' })
    expect(decidePortAdoption({ port: 5174, health: null, pidfile: null, wanted })).toEqual({ kind: 'ephemeral', reason: 'inconclusive' })
  })

  it('B-critical: a TIMEOUT on a port whose pidfile records a DIFFERENT port does NOT adopt — stays inconclusive', () => {
    // The exact branch a cross-family verify flagged as untested: health===null (no answer)
    // combined with a non-null pidfile that owns ANOTHER port. Without authenticated ownership
    // of THIS port, a timeout must never be trusted into adoption.
    expect(decidePortAdoption({ port: 5174, health: null, pidfile: pf({ port: 5999 }), wanted })).toEqual({ kind: 'ephemeral', reason: 'inconclusive' })
  })

  // Card #1815076918890857882 — a stale pidfile whose recorded process DIED and whose port a
  // FOREIGN process rebound must NOT read as owned (same-uid loopback hardening).
  it('#2 hardening: a DEAD recorded pid (pidAlive=false) never authenticates ownership → ephemeral, not adopt', () => {
    // health answers as a DIFFERENT (foreign) observe origin now on the port; the stale pidfile
    // still records THIS port, but its process is gone.
    const d = decidePortAdoption({ port: 5174, health: { app: 'something-else' }, pidfile: pf(), wanted, pidAlive: false })
    expect(d).toEqual({ kind: 'ephemeral', reason: 'foreign' })
  })

  it('#2 hardening: a RECYCLED pid (alive but identity mismatch) never authenticates ownership → ephemeral', () => {
    // pid is alive but boot-id/proc-start no longer match the pidfile → a different process
    // reusing the number. A no-answer probe with no authenticated ownership stays inconclusive.
    const d = decidePortAdoption({ port: 5174, health: null, pidfile: pf(), wanted, pidAlive: true, pidIdentityMatches: false })
    expect(d).toEqual({ kind: 'ephemeral', reason: 'inconclusive' })
  })

  it('a LIVE, identity-matching pidfile still adopts (the happy path is unchanged when the guards pass)', () => {
    const d = decidePortAdoption({ port: 5174, health: null, pidfile: pf(), wanted, pidAlive: true, pidIdentityMatches: true })
    expect(d).toEqual({ kind: 'adopt', served: ['/home/u/.claude'], mismatch: false })
  })
})

describe('resolveRemoteMounts (shared probe→explode loop)', () => {
  it('probes each entry, notes a null probe, and explodes a hub into per-source mounts', async () => {
    const entries = [
      { key: 'remote-up', url: 'http://up:5174' },
      { key: 'remote-down', url: 'http://down:5174' },
    ]
    const probe = async (r: { url: string }) =>
      r.url === 'http://up:5174' ? { app: 'observe-ui', sources: [{ key: 'a', configDir: '/x/.claude' }] } : null
    const { mounts, notes } = await resolveRemoteMounts(entries, probe)
    expect(mounts.map((m) => m.key)).toEqual(['remote-up-a', 'remote-down'])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('http://down:5174')
  })

  it('reports unprobed entries in `unhealthy` so an embedding shell can re-probe later (auto-reconnect)', async () => {
    const entries = [
      { key: 'remote-up', url: 'http://up:5174' },
      { key: 'remote-down', url: 'http://down:5174' },
    ]
    const probe = async (r: { url: string }) =>
      r.url === 'http://up:5174' ? { app: 'observe-ui', sources: [] } : null
    const { unhealthy } = await resolveRemoteMounts(entries, probe)
    expect(unhealthy.map((r) => r.key)).toEqual(['remote-down'])
  })

  it('unhealthy is empty when every probe answers', async () => {
    const entries = [{ key: 'r1', url: 'http://up:5174' }]
    const { unhealthy } = await resolveRemoteMounts(entries, async () => ({ app: 'observe-ui', sources: [] }))
    expect(unhealthy).toEqual([])
  })
})
