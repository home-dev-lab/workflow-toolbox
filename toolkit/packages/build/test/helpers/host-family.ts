import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { expect } from 'vitest'

type Host = {
  platform: string
  endProcessFamily: (pid: number) => { status: string; kind: string }
  forceEndProcessFamily: (pid: number) => { status: string; kind: string }
  readProcessLiveness: (pid: number) => { status: string }
}

const descendantScript = "process.send({pid:process.pid}); setInterval(()=>{},60000)"
const leaderScript = `
  const {spawn}=require('node:child_process');
  const descendant=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:['ignore',1,'ignore','ipc']});
  descendant.once('message',({pid})=>process.stdout.write(JSON.stringify({leader:process.pid,descendant:pid})+'\\n'));
  process.on('SIGTERM',()=>{
    if(descendant.exitCode!==null||descendant.signalCode!==null) process.exit(0);
    descendant.once('exit',()=>process.exit(0));
  });
  setInterval(()=>{},60000);
`

async function waitUntil(check: () => boolean, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  return check()
}

export async function exerciseRealFamily(host: Host, force: boolean) {
  const leader = spawn(process.execPath, ['-e', leaderScript], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let familyOutputClosed = false
  leader.stdout.once('close', () => { familyOutputClosed = true })
  let descendantPid: number | undefined
  try {
    const ready = await familyReady(leader)
    descendantPid = ready.descendant
    expect(ready.leader).toBe(leader.pid)
    expect(host.readProcessLiveness(ready.leader).status).toBe('alive')
    expect(host.readProcessLiveness(descendantPid).status).toBe('alive')
    const result = force ? host.forceEndProcessFamily(ready.leader) : host.endProcessFamily(ready.leader)
    expect(result).toEqual({ status: 'ended', kind: host.platform === 'win32' ? 'process_tree' : 'posix_process_group' })
    expect(await waitUntil(() => leader.exitCode !== null || leader.signalCode !== null), 'family leader exited').toBe(true)
    // Both fixtures keep this pipe open for their entire lifetime. Its EOF proves
    // the descendant exited too, even when a container init has not reaped its zombie.
    expect(await waitUntil(() => familyOutputClosed), 'family descendant exited (inherited output closed)').toBe(true)
  } finally {
    if (leader.pid) host.forceEndProcessFamily(leader.pid)
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch {} }
  }
}

function familyReady(leader: ChildProcessByStdio<null, Readable, null>) {
  return new Promise<{ leader: number; descendant: number }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('host family readiness timed out')), 5_000)
    let output = ''
    leader.once('error', (error) => { clearTimeout(timeout); reject(error) })
    leader.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (!output.includes('\n')) return
      clearTimeout(timeout); resolve(JSON.parse(output.trim()))
    })
  })
}

export async function exerciseExitedChild(host: Host, child: ChildProcess) {
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('host liveness child exit timed out')), 5_000)
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('close', () => { clearTimeout(timeout); resolve() })
    })
    expect(child.pid, 'liveness child started').toBeDefined()
    expect(host.readProcessLiveness(child.pid!).status).toBe('gone')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}
