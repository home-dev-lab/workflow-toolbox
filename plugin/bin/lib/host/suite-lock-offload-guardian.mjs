import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import net from 'node:net'

// This group leader lives outside the broker. EOF on its private pipe also follows broker SIGKILL;
// the operator command never inherits the pipe, so it cannot accidentally keep its guardian alive.
const [command, directory, seconds] = process.argv.slice(2)
const owner = new net.Socket({ fd: 3, readable: true, writable: false })
const cancel = () => {
  try { rmSync(directory, { recursive: true, force: true }) } catch { /* The broker may have removed it. */ }
  process.kill(-process.pid, 'SIGKILL')
}
owner.on('end', cancel)
owner.on('error', cancel)
owner.resume()
process.stdout.on('error', cancel)
const deadline = setTimeout(cancel, Number(seconds) * 1000)
const child = spawn(command, [], { shell: false, stdio: ['pipe', 'inherit', 'ignore'] })
process.stdin.pipe(child.stdin)
child.stdin.on('error', () => {})
child.once('error', (error) => {
  process.stdout.write(JSON.stringify({ outcome: 'fallback', reason: `offload spawn failed: ${error.code}` }) + '\n')
})
// Stop every surviving descendant before this guardian disappears, even if the broker is suspended
// or dies before processing stdout. The command's valid last line, not this process exit, is the result.
child.once('close', () => { clearTimeout(deadline); cancel() })
