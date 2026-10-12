import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import console from 'node:console'

type SandboxContext = { inside: boolean; why: string }
type ContextOptions = { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; readFile?: (file: string) => string }
type LaneTestContext = { task: { name: string; file?: { filepath: string } }; skip: (note?: string) => void }

function readNamespaceFile(file: string, readFile: (file: string) => string): string | null {
  try { return readFile(file).trim() } catch { return null }
}

function namespaceContext(readFile: (file: string) => string): SandboxContext {
  const uidMap = readNamespaceFile('/proc/self/uid_map', readFile)
  if (uidMap === null) return { inside: false, why: '/proc/self/uid_map unreadable' }
  if (/^\s*0\s+0\s+4294967295\s*$/.test(uidMap)) return { inside: false, why: '/proc/self/uid_map is the initial user namespace' }
  const init = readNamespaceFile('/proc/1/comm', readFile)
  if (init === null) return { inside: false, why: '/proc/1/comm unreadable' }
  if (init !== 'bwrap') return { inside: false, why: '/proc/1/comm does not name bwrap' }
  return { inside: true, why: 'linux, WT_LANE_SANDBOX=bwrap, CI empty, non-initial user namespace, PID 1=bwrap' }
}

/** Require launcher and namespace evidence; an unreadable signal never authorizes adaptation. */
export function laneSandboxContext({ env = process.env, platform = process.platform, readFile = (file) => readFileSync(file, 'utf8') }: ContextOptions = {}): SandboxContext {
  if (platform !== 'linux') return { inside: false, why: 'platform is not linux' }
  if (env.WT_LANE_SANDBOX !== 'bwrap') return { inside: false, why: 'WT_LANE_SANDBOX is not bwrap' }
  if (env.CI) return { inside: false, why: 'CI is nonempty' }
  return namespaceContext(readFile)
}

export function skipInsideLaneSandbox(ctx: LaneTestContext, missingCapability: string | null, context = laneSandboxContext()): void {
  if (!context.inside || !missingCapability) return
  console.warn(`[lane-sandbox skip] ${basename(ctx.task.file?.filepath ?? '<unknown test file>')} > ${ctx.task.name}: ${missingCapability}`)
  ctx.skip('lane sandbox: ' + missingCapability)
}

/** Node's console also stays visible when an agent reporter suppresses intercepted passing-test logs. */
export function noteInsideLaneSandbox(label: string, detail: string, context = laneSandboxContext()): void {
  if (context.inside) console.warn(`[lane-sandbox skip] ${label}: lane sandbox: ${detail}`)
}
