import { runSignerGit, withSignerConfigLock } from './ssh-sign-config-lock.mjs'

function git(args) {
  const result = runSignerGit(['config', ...args])
  if (result.error) throw result.error
  if (result.status !== 0 && result.status !== 1) throw new Error(`git config failed: ${result.stderr.trim()}`)
  return result
}

function commandWord(value) {
  // Git uses its command shell for gpg.ssh.program, including sh in Git for Windows.
  const portable = process.platform === 'win32' ? value.replaceAll('\\', '/') : value
  return `'${portable.replaceAll("'", "'\\''")}'`
}

function signerPresent(scope) {
  // Effective values AND the write scope are checked: an empty value is still set.
  for (const args of [['--get-all', 'gpg.ssh.program'], [scope, '--get-all', 'gpg.ssh.program']]) {
    const existing = git(args)
    if (existing.status === 0) {
      process.stdout.write(`adopt: gpg.ssh.program PRESENT (left alone): ${JSON.stringify(existing.stdout.replace(/\n$/, ''))}\n`)
      return true
    }
  }
  return false
}

function effectiveValue(key) {
  const result = git(['--null', '--includes', '--get', key])
  return result.status === 1 ? null : result.stdout.replace(/\0$/, '')
}

function signingConfig() {
  return { program: effectiveValue('gpg.ssh.program'), key: effectiveValue('user.signingkey'), defaultKeyCommand: effectiveValue('gpg.ssh.defaultKeyCommand') }
}

function verifyConfig(command, before) {
  let effective
  try { effective = signingConfig() }
  catch (error) {
    process.stdout.write(`adopt: gpg.ssh.program REFUSED: cannot resolve effective signing configuration: ${error.message}; restoring previous config; rerun the same adopt command\n`)
    return false
  }
  if (effective.program === command && effective.key === before.key && effective.defaultKeyCommand === before.defaultKeyCommand) return true
  process.stdout.write(`adopt: gpg.ssh.program REFUSED: signing configuration changed; effective=${JSON.stringify(effective)}; intended=${JSON.stringify({ ...before, program: command })}; restoring previous config; rerun the same adopt command\n`)
  return false
}

function writeCommand(stage, command) {
  const result = git(['--file', stage, '--add', 'gpg.ssh.program', command])
  if (result.status !== 0) throw new Error(`could not set gpg.ssh.program: ${result.stderr.trim()}`)
  return true
}

export function configureSshSignRetry({ target, global, mode, ready }) {
  const scope = global ? '--global' : '--local'
  if (signerPresent(scope)) return
  if (mode !== 'install') {
    process.stdout.write(`adopt: gpg.ssh.program ABSENT (would set ${scope} on --set ssh-sign-retry --install)\n`)
    return
  }
  if (!ready) {
    process.stdout.write('adopt: gpg.ssh.program left alone: retry wrapper is not a current unedited managed file\n')
    return
  }
  const command = `${commandWord(process.execPath)} ${commandWord(target)}`
  const before = signingConfig()
  const wrote = withSignerConfigLock(scope, (stage) => {
    if (signerPresent(scope)) return false
    return writeCommand(stage, command)
  }, () => verifyConfig(command, before))
  if (wrote) process.stdout.write(`adopt: gpg.ssh.program WROTE ${scope}: ${command}\n`)
}
