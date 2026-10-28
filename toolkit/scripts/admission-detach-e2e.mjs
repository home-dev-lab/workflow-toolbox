#!/usr/bin/env node
// Local process-only proof: no model launcher or network dependency is involved.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { boundedAdmission } from '../../plugin/bin/lib/host/admission.mjs'

function running(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X', 'x'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0])
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function demonstrate(mode) {
  const root = mkdtempSync(join(tmpdir(), 'admission-detach-e2e-'))
  const policy = join(root, 'policy.mjs'), marker = join(root, 'sleeper.pid')
  writeFileSync(policy, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
    export default () => {
      const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
      writeFileSync(${JSON.stringify(marker)}, String(sleeper.pid)); sleeper.unref();
      return ${mode === 'verdict' ? "'policy refuses'" : 'new Promise(() => {})'};
    }`)
  let pid
  try {
    const controller = new AbortController()
    const pending = boundedAdmission({ repo: root, request: {}, signal: controller.signal }, { WT_E2E_ADMISSION: policy, WT_E2E_TIMEOUT: '1500' }, {
      moduleVariable: 'WT_E2E_ADMISSION', timeoutVariable: 'WT_E2E_TIMEOUT', silent: true,
    })
    if (mode === 'abort') {
      const deadline = performance.now() + 1000
      while (!existsSync(marker) && performance.now() < deadline) await sleep(5)
      controller.abort()
    }
    const verdict = await pending
    pid = Number(readFileSync(marker, 'utf8'))
    const aliveAfterReturn = running(pid)
    console.log(JSON.stringify({ mode, sleeperPid: pid, verdict, aliveAfterReturn }))
    const expected = `WT_E2E_ADMISSION: ${mode === 'verdict' ? 'policy refuses' : mode === 'abort' ? 'interrupted during admission' : 'timed out after 1500 ms'}`
    try {
      assert.equal(verdict, expected)
      assert.equal(aliveAfterReturn, false, 'detached policy process must stop after admission returns')
    } catch (error) { console.error(error.message); process.exitCode = 1 }
  } finally {
    try { pid ??= Number(readFileSync(marker, 'utf8')); process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
    await sleep(10)
    rmSync(root, { recursive: true, force: true })
  }
}

const hasContainment = process.platform === 'linux' && spawnSync('/usr/bin/python3', ['-I', '-c',
  'import ctypes; assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0',
], { stdio: 'ignore' }).status === 0
if (hasContainment) {
  await demonstrate('verdict')
  await demonstrate('timeout')
  await demonstrate('abort')
} else {
  console.error(`containment unknown (${process.platform}): Linux with python3/subreaper is required; detached-process assertions explicitly skipped`)
}
