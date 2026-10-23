import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

const SOURCE = fileURLToPath(new URL('../../../../plugin/bin/lib/host/wt-ssh-sign-retry.mjs', import.meta.url))

function lookup(files: string[], env: Record<string, string>, platform = 'linux', readable = true, eligibility = 'executable') {
  // Evaluate the actual standalone resolver with a synthetic filesystem, never native OpenSSH.
  const source = readFileSync(SOURCE, 'utf8').replace(/^import .*$/gm, '').replaceAll('import.meta.url', 'wrapperUrl')
  const code = source.slice(0, source.indexOf('if (invokedDirectly()) {'))
  const contents = Buffer.from(eligibility === 'wrapper' ? '// Standalone adopted program: no plugin installation or neighbouring modules needed.' : 'native executable')
  const filesystem = {
    constants: { X_OK: 1 },
    realpathSync: { native: (candidate: string) => candidate },
    statSync(candidate: string) {
      if (candidate !== '/wrapper' && !files.includes(candidate)) throw new Error('ENOENT')
      return { dev: 1n, ino: candidate === '/wrapper' || eligibility === 'self' ? 1n : 2n, isFile: () => eligibility !== 'directory' }
    },
    accessSync() { if (eligibility === 'denied') throw new Error('EACCES') },
    openSync(candidate: string) {
      if (!readable) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return candidate
    },
    readSync(_fd: string, buffer: Buffer) { contents.copy(buffer); return contents.length },
    closeSync() {},
  }
  const resolve = runInNewContext(`${code}\nresolveKeygen`, {
    fs: filesystem, path: platform === 'win32' ? path.win32 : path.posix, Buffer,
    process: { platform, env, cwd: () => process.cwd() }, fileURLToPath: () => '/wrapper', wrapperUrl: 'file:///wrapper',
  }) as () => string
  return resolve()
}

it('review: unset POSIX PATH uses the executable lookup default', () => {
  expect(lookup(['/usr/bin/ssh-keygen'], {})).toBe('/usr/bin/ssh-keygen')
})

it('review: an explicitly empty PATH still searches the current directory', () => {
  const file = path.posix.resolve('ssh-keygen')
  expect(lookup([file], { PATH: '' })).toBe(file)
})

it('review: an execute-only native program remains eligible for lookup', () => {
  expect(lookup(['/bin/ssh-keygen'], { PATH: '/bin' }, 'linux', false)).toBe('/bin/ssh-keygen')
})

it.each(['.com', '.exe'])('review: Windows resolves native %s executables', (extension) => {
  const file = `C:\\OpenSSH\\ssh-keygen${extension}`
  expect(lookup([file], { PATH: 'C:\\OpenSSH', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')).toBe(file)
})

it.each(['.CMD', '.BAT'])('review: earlier Windows %s shim is reported instead of bypassed', (extension) => {
  expect(() => lookup([
    `C:\\shim\\ssh-keygen${extension.toLowerCase()}`, 'C:\\OpenSSH\\ssh-keygen.exe',
  ], { PATH: 'C:\\shim;C:\\OpenSSH', PATHEXT: `${extension};.EXE` }, 'win32')).toThrow('unsupported Windows command shim')
})

it.each(['.COM;.EXE', '.EXE;.COM'])('review: Windows honors PATHEXT order %s within a directory', (PATHEXT) => {
  const files = ['C:\\OpenSSH\\ssh-keygen.com', 'C:\\OpenSSH\\ssh-keygen.exe']
  expect(lookup(files, { PATH: 'C:\\OpenSSH', PATHEXT }, 'win32')).toBe(`C:\\OpenSSH\\ssh-keygen${PATHEXT.split(';')[0]!.toLowerCase()}`)
})

it.each(['/opt/team"', '"/opt/team'])('r3: POSIX PATH preserves literal quotes in %s', (directory) => {
  const intended = path.posix.resolve(directory, 'ssh-keygen')
  expect(lookup([intended, '/opt/team/ssh-keygen'], { PATH: directory })).toBe(intended)
})

it.each(['directory', 'self', 'denied', 'wrapper'])('r3: lookup rejects %s independently of the other guards', (eligibility) => {
  expect(() => lookup(['/bin/ssh-keygen'], { PATH: '/bin' }, 'linux', true, eligibility)).toThrow('not found on PATH')
})

it('r3: Windows still accepts a quoted PATH directory', () => {
  expect(lookup(['C:\\OpenSSH\\ssh-keygen.exe'], { PATH: '"C:\\OpenSSH"', PATHEXT: '.EXE' }, 'win32')).toBe('C:\\OpenSSH\\ssh-keygen.exe')
})
