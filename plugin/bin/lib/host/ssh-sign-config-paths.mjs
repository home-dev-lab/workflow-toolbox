import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { isUtf8 } from 'node:buffer'

export function runSignerGit(args, env = process.env) {
  // GIT_CONFIG is specific to `git config`; commits ignore it. Query commit context.
  const result = spawnSync('git', args, { env: { ...env, GIT_CONFIG: undefined } })
  if (result.stdout && !isUtf8(result.stdout)) {
    throw new Error(`gpg.ssh.program REFUSED: Git reported non-UTF-8 output for git ${args.join(' ')}; use valid UTF-8 configuration values and rerun the same adopt command`)
  }
  // Validate before decoding; Buffer's decoder also preserves a leading UTF-8 BOM.
  return { ...result, stdout: result.stdout?.toString('utf8') ?? '', stderr: result.stderr?.toString('utf8') ?? '' }
}

function gitOutput(args) {
  const result = runSignerGit(args)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git config path failed: ${result.stderr.trim()}`)
  return result.stdout.replace(/\n$/, '')
}

function gitPath(value) {
  // Git owns HOME interpolation. NUL preserves whitespace/newlines in filenames.
  return gitOutput(['config', '--file', os.devNull, '--null', '--type=path', '--get', '--default', value, 'workflowtoolboxadopt.path']).replace(/\0$/, '')
}

function globalTarget() {
  if (process.env.GIT_CONFIG_GLOBAL !== undefined) return process.env.GIT_CONFIG_GLOBAL
  const home = gitPath('~/.gitconfig')
  const xdg = process.env.XDG_CONFIG_HOME
  const alternative = xdg ? `${xdg}/git/config` : gitPath('~/.config/git/config')
  return fs.existsSync(home) || !fs.existsSync(alternative) ? home : alternative
}

export function signerConfigTarget(scope) {
  return canonical(scope === '--global' ? globalTarget() : gitOutput(['rev-parse', '--path-format=absolute', '--git-path', 'config']))
}

function canonical(file) {
  // Preserve kernel symlink/.. traversal before forming the target's lock pathname.
  try { return fs.realpathSync.native(file) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    try {
      const link = fs.readlinkSync(file)
      return canonical(path.isAbsolute(link) ? link : `${path.dirname(file)}${path.sep}${link}`)
    } catch (linkError) {
      if (!['ENOENT', 'EINVAL'].includes(linkError.code)) throw linkError
    }
    return path.join(canonical(path.dirname(file)), path.basename(file))
  }
}
