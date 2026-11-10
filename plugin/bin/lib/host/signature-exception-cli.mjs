import { join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { authorizationDestination, exceptionStatement, findOwnerException, pinOwnerKey, PIN_STATEMENT } from '../signature-exception.mjs'
import { exceptionStatus, readJson, signatureCommand } from './signature-exception-io.mjs'
import { identity, isPinnedEngine, verifyInstall } from './push-guard-runtime.mjs'

const USAGE = 'Usage: wt-signature-exception.mjs (pin --attestation <file> | status | preview --remote <name> --ref <full-ref> --new <sha>) --repo <path>'
export const signatureExceptionHelp = `${USAGE}\nPin setup: call Atrium request_authorization with exactly ${JSON.stringify(PIN_STATEMENT)}, save the returned JSON, then use pin. Check the identity with Atrium get_owner; the first pin is TOFU. Rotation requires deliberately deleting the old pin and pinning again. Preview never consumes an answer.\n`
function parse(args) {
  const [command, ...flags] = args
  if (!['pin', 'preview', 'status'].includes(command)) throw Error(USAGE)
  const opts = { command }
  const names = { '--repo': 'repo', '--attestation': 'attestation', '--remote': 'remote', '--ref': 'ref', '--new': 'newSha' }
  for (let i = 0; i < flags.length; i += 2) {
    if (!names[flags[i]] || !flags[i + 1] || opts[names[flags[i]]] !== undefined) throw Error(USAGE)
    opts[names[flags[i]]] = flags[i + 1]
  }
  if (!opts.repo) throw Error(USAGE)
  opts.repo = resolve(opts.repo)
  return opts
}

function git(repo, args) {
  const result = signatureCommand('git', ['-C', repo, ...args])
  if (result.error || result.status !== 0) throw Error(`git lookup failed: ${result.stderr}`)
  return result.stdout.trim()
}

function installedDirectory(repo) {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return join(common, 'hooks', 'wt-push-guard')
}

function forwardToPinned(dir, args, repo) {
  const engine = fileURLToPath(new URL('../../wt-push-scope-check.mjs', import.meta.url))
  if (isPinnedEngine(engine, realpathSync(dir))) return null
  const result = signatureCommand(process.execPath, [join(dir, 'bin/wt-signature-exception.mjs'), ...args], { cwd: repo })
  if (result.error || !result.stdout) throw Error('install-predates-exceptions: reinstall with node plugin/bin/wt-push-guard-install.mjs --install --repo <repo> --guard-remote <remote>')
  process.stdout.write(result.stdout)
  return { exit: result.status === 0 ? 0 : 1 }
}

function preview(opts, config) {
  if (!opts.remote || !opts.ref || !opts.newSha) throw Error(USAGE)
  const url = git(opts.repo, ['remote', 'get-url', '--push', opts.remote])
  const authorized = git(opts.repo, ['rev-parse', '--path-format=absolute', '--git-path', 'wt-push-authorized.json'])
  if (!identity(config, opts.remote, url, authorized)) throw Error('no exception exists: installed guard does not cover this destination')
  const statement = exceptionStatement({ destination: authorizationDestination(url, opts.repo), ref: opts.ref, newSha: opts.newSha })
  return findOwnerException({ statement, config })
}

export function runSignatureExceptionCli(args) {
  try {
    const opts = parse(args)
    const dir = installedDirectory(opts.repo)
    const forwarded = forwardToPinned(dir, args, opts.repo)
    if (forwarded) return forwarded.exit
    const config = verifyInstall(dir)
    let result
    if (opts.command === 'preview') result = preview(opts, config)
    else if (opts.command === 'pin') {
      if (!opts.attestation) throw Error(`${USAGE}\nRequest Atrium authorization for exactly: ${PIN_STATEMENT}`)
      result = pinOwnerKey({ config, answer: readJson(opts.attestation) })
    } else result = { ...exceptionStatus(config), limit: 'TOFU; only relayed attestations are visible; answer_id is unverified transport metadata.' }
    console.log(JSON.stringify(result))
    return result.failure ? 1 : 0
  } catch (error) {
    console.log(JSON.stringify({ failure: { cause: error.message } }))
    return 1
  }
}
