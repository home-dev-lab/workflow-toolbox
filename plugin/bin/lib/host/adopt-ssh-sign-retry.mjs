import { spawnSync } from 'node:child_process'

function git(args) {
  const result = spawnSync('git', ['config', ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 && result.status !== 1) throw new Error(`git config failed: ${result.stderr.trim()}`)
  return result
}

function commandWord(value) {
  // Git uses its command shell for gpg.ssh.program, including sh in Git for Windows.
  const portable = process.platform === 'win32' ? value.replaceAll('\\', '/') : value
  return `'${portable.replaceAll("'", "'\\''")}'`
}

export function configureSshSignRetry({ target, global, mode, ready }) {
  const scope = global ? '--global' : '--local'
  // Effective values AND the write scope are checked: an empty value is still set.
  for (const args of [['--get-all', 'gpg.ssh.program'], [scope, '--get-all', 'gpg.ssh.program']]) {
    const existing = git(args)
    if (existing.status === 0) {
      process.stdout.write(`adopt: gpg.ssh.program PRESENT (left alone): ${JSON.stringify(existing.stdout.replace(/\n$/, ''))}\n`)
      return
    }
  }
  if (mode !== 'install') {
    process.stdout.write(`adopt: gpg.ssh.program ABSENT (would set ${scope} on --set ssh-sign-retry --install)\n`)
    return
  }
  if (!ready) {
    process.stdout.write('adopt: gpg.ssh.program left alone: retry wrapper is not a current unedited managed file\n')
    return
  }
  const command = `${commandWord(process.execPath)} ${commandWord(target)}`
  const result = git([scope, '--add', 'gpg.ssh.program', command])
  if (result.status !== 0) throw new Error(`could not set gpg.ssh.program: ${result.stderr.trim()}`)
  process.stdout.write(`adopt: gpg.ssh.program WROTE ${scope}: ${command}\n`)
}
