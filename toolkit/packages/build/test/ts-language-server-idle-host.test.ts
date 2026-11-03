import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const root = process.env.WT_TSLS_IDLE_TEST_ROOT ?? fileURLToPath(new URL('../../../../plugin/', import.meta.url))
const url = (name: string) => pathToFileURL(join(root, `bin/lib/host/${name}.mjs`)).href
const priority = await import(url('ts-priority'))
const processes = await import(url('ts-process'))

it('launches a native backend in the verified low-weight scope', () => {
  const launch = vi.fn(), options = { stdio: 'pipe' }
  processes.spawnTsProcess('/backend', ['--lsp'], options, {
    launch, scope: () => ({ status: 'available', command: 'systemd-run', args: ['CPUWeight=1', '--'] }),
  })
  expect(launch, 'an available scope must wrap the actual backend launch').toHaveBeenCalledWith('systemd-run', ['CPUWeight=1', '--', '/backend', '--lsp'], expect.objectContaining({ detached: process.platform !== 'win32' }))
})

it('reports the actual scheduling scope and lowers every existing Linux thread', () => {
  const stderr = new PassThrough(), set = vi.fn(), get = vi.fn(() => 19)
  let text = ''
  stderr.on('data', chunk => { text += chunk.toString() })
  priority.lowerTsPriority({ set, get, stderr, platform: 'linux', threads: () => [101, 102] })
  expect(set, 'existing Linux threads must also receive nice 19').toHaveBeenCalledWith(101, 19)
  expect(set).toHaveBeenCalledWith(102, 19)
  expect(text, 'priority diagnostic must state cgroup and WSL2 limits').toMatch(/cgroup.*thread.*WSL2.*Windows/)
})

it.each([0, 1])('uses an available dependency-free low-weight user scope (probe status %s)', status => {
  expect(typeof priority.tsCpuScope, 'Linux needs a real low-weight scope availability probe').toBe('function')
  const probe = vi.fn(() => ({ status })), stderr = new PassThrough()
  let text = ''; stderr.on('data', chunk => { text += chunk.toString() })
  const scope = priority.tsCpuScope({ platform: 'linux', probe, stderr })
  expect(probe).toHaveBeenCalled()
  expect(scope.status).toBe(status === 0 ? 'available' : 'unavailable')
  if (status === 0) expect(scope.args).toContain('CPUWeight=1')
  else expect(text).toContain('low-weight scope unavailable')
})

it.each(['1', '100'])('verifies the actual cgroup weight in the scope probe (%s)', weight => {
  const probe = (_command: string, args: string[]) => {
    const bootstrap = `const filesystem=require('node:fs');filesystem.readFileSync=p=>p==='/proc/self/cgroup'?'0::/test\\n':${JSON.stringify(weight)};`
    return spawnSync(process.execPath, ['-e', bootstrap + args.at(-1)], { encoding: 'utf8' })
  }
  const scope = priority.tsCpuScope({ platform: 'linux', probe, stderr: new PassThrough() })
  expect(scope.status, 'a scope must have cpu.weight=1, not merely accept the systemd property').toBe(weight === '1' ? 'available' : 'unavailable')
})

function backendProgram() {
  return `import {spawn} from 'node:child_process';
    import {tsFrame,tsFrameReader} from ${JSON.stringify(url('ts-lsp-wire'))};
    process.on('SIGTERM',()=>{});
    const descendant=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});
    process.stderr.write('DESCENDANT='+descendant.pid+'\\n');
    process.stdin.on('data',tsFrameReader(m=>{if(m.method==='initialize')process.stdout.write(tsFrame({jsonrpc:'2.0',id:m.id,result:{capabilities:{}}}))}));
    setInterval(()=>{},1000);`
}

function stopProof(signal: boolean) {
  return `import {spawn} from 'node:child_process';import{PassThrough}from'node:stream';import{readFileSync}from'node:fs';
    import{runTsIdleSession}from ${JSON.stringify(url('ts-idle-session'))};import{tsFrame}from ${JSON.stringify(url('ts-lsp-wire'))};
    const input=new PassThrough(),output=new PassThrough(),stderr=new PassThrough();let log='',child,exits=[];
    stderr.on('data',c=>log+=c);const alive=pid=>{if(!pid)return true;try{process.kill(pid,0);return !/\\) Z /.test(readFileSync('/proc/'+pid+'/stat','utf8'))}catch(e){return e.code!=='ESRCH'&&e.code!=='ENOENT'}};
    runTsIdleSession({input,output,stderr,idleMs:1000,stopMs:30,exit:c=>exits.push(c),exitSignal:s=>exits.push(s),
      select:()=>({status:'launch',backend:'typescript-go',command:process.execPath,args:[]}),
      start:(c,a,o)=>child=spawn(c,['--input-type=module','-e',${JSON.stringify(backendProgram())}],o)});
    const report=()=>{const pid=Number(/DESCENDANT=(\\d+)/.exec(log)?.[1]);
      const result={descendantPid:pid,descendantAlive:alive(pid),leaderAlive:alive(child.pid),exits,log};
      try{process.kill(-child.pid,'SIGKILL')}catch{};try{process.kill(pid,'SIGKILL')}catch{};child.kill('SIGKILL');
      console.log(JSON.stringify(result));process.exit(0)};
    output.once('data',()=>{${signal ? "setTimeout(()=>process.emit('SIGTERM'),0);" : ''}setTimeout(report,2200)});
    input.write(tsFrame({jsonrpc:'2.0',id:1,method:'initialize',params:{}}));
    setTimeout(report,6000).unref();`
}

it.skipIf(process.platform !== 'linux').each([false, true])('bounds a real TERM-resistant process tree and inherited pipes (wrapper signal=%s)', signal => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', stopProof(signal)], { encoding: 'utf8', timeout: 10_000 })
  expect(result.status, result.stderr).toBe(0)
  const proof = JSON.parse(result.stdout)
  expect(proof.descendantPid, proof.log).toBeGreaterThan(0)
  expect(proof.descendantAlive, 'forced retirement must kill backend descendants').toBe(false)
  expect(proof.leaderAlive, 'forced retirement must kill its leader').toBe(false)
  if (signal) expect(proof.exits, 'wrapper SIGTERM must terminate the wrapper session').toContain('SIGTERM')
})
