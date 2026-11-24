import assert from 'node:assert/strict'
import { readdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { events, fixture, fresh, held, live, moduleUrl, scanner } from './helpers/launcher-fixtures.mjs'

test('A: a slow reader never blocks a one-shot publisher', async (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const reader = await held(t, f, String.raw`const m = await import(eventUrl);
    m.takeLauncherEvent('delegate',{...options,deliver:()=>hold()});`)
  const result = fresh(f, String.raw`const m = await import(eventUrl);
    const result=m.appendLauncherEvent('delegate',{key:'B',line:'B'},options);
    assert.equal(result?.line,'B','one-shot publication must succeed while a reader is slow');`)
  assert.equal(result.status, 0)
  reader.child.kill('SIGKILL'); await reader.ended
  const lines = []
  for (let event; (event = events.takeLauncherEvent('delegate', f.options));) lines.push(event.line)
  assert.deepEqual(lines.sort(), ['A', 'B'], 'both events must be delivered exactly once')
})

test('B: EACCES routing cannot change sweep or waiter caller exit', (t) => {
  const f = fixture(t); live(f)
  const result = fresh(f, String.raw`const mkdir=fs.mkdirSync;
    fs.mkdirSync=(file,...args)=>{if(String(file).includes('wt-launcher-events')) throw Object.assign(new Error('denied'),{code:'EACCES'});return mkdir(file,...args)};
    syncBuiltinESMExports();
    const {createLaneExitNotices}=await import(${JSON.stringify(moduleUrl('lib/lane-exit-notices.mjs'))});
    const store={load:()=>({entries:new Map(),baseline:false}),records:()=>[{record,modifiedAt:options.now}],reportPresent:()=>false};
    createLaneExitNotices({...options,sessionId:'session',store,write:()=>{},stderr:line=>fs.writeSync(2,line+'\n')})();`)
  assert.match(result.stderr, /launcher-publish-failed.*EACCES/)
  const waiter = fresh(f, String.raw`const mkdir=fs.mkdirSync;
    fs.mkdirSync=(file,...args)=>{if(String(file).includes('wt-launcher-events')) throw Object.assign(new Error('denied'),{code:'EACCES'});return mkdir(file,...args)};
    syncBuiltinESMExports();
    const {startLauncherWait}=await import(${JSON.stringify(moduleUrl('lib/launcher-wait.mjs'))});
    startLauncherWait('delegate',{...options,timeout:0});`, 125)
  assert.match(waiter.stderr, /launcher-read-failed.*EACCES/)
})

test('B: cleanup EACCES cannot change a successful waiter exit', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const result = fresh(f, String.raw`const list=fs.readdirSync;
    fs.readdirSync=(file,...args)=>{if(String(file).includes('claimed-'))throw Object.assign(new Error('cleanup denied'),{code:'EACCES'});return list(file,...args)};
    syncBuiltinESMExports();
    const {startLauncherWait}=await import(${JSON.stringify(moduleUrl('lib/launcher-wait.mjs'))});
    startLauncherWait('delegate',{...options,timeout:0});`)
  assert.equal(result.stdout, 'A\n')
  assert.match(result.stderr, /launcher-cleanup-failed.*EACCES/)
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('C: archive failure prints nothing for that record and keeps scanning', (t) => {
  const f = fixture(t); delete f.record.launcherAgentId
  const second = { ...f.record, runId: '30-40' }; let writes = 0
  const store = { load: () => ({ entries: new Map(), baseline: false }),
    records: () => [f.record, second].map((record) => ({ record, modifiedAt: f.options.now })), reportPresent: () => false }
  const s = scanner(f, { store, write: () => { if (++writes === 1) throw new Error('archive denied') } })
  s.sweep()
  assert.equal(s.lines.length, 1, 'only the successfully archived record may print')
  assert.match(s.lines[0], /runId=30-40/, 'one failed record must not stop the rest of the scan')
  s.sweep()
  assert.equal(s.lines.length, 2, 'retry must deliver the failed record without repeating the successful one')
})

test('D: SIGKILL after claim returns the dead reader event to pending', async (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const reader = await held(t, f, String.raw`const m=await import(eventUrl);m.takeLauncherEvent('delegate',{...options,deliver:()=>hold()});`)
  assert.equal(readdirSync(f.box).filter((name) => name.startsWith('claimed-')).length, 1,
    'delivery must first rename the event into a private reader claim')
  reader.child.kill('SIGKILL'); await reader.ended
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'A', 'a positively dead reader must be recovered')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null, 'recovered event must be acknowledged once')
})

test('E: two real readers race one event and exactly one prints', async (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const first = await held(t, f, String.raw`const m=await import(eventUrl);m.takeLauncherEvent('delegate',{...options,deliver:item=>{fs.writeSync(1,item.line+'\n');hold()}});`)
  const second = fresh(f, String.raw`const m=await import(eventUrl);m.takeLauncherEvent('delegate',{...options,deliver:item=>{fs.writeSync(1,item.line+'\n')}});`)
  assert.equal(second.stdout, '', 'the losing reader must skip the already claimed event silently')
  writeFileSync(path.join(f.root, 'release'), 'release'); await first.ended
  assert.equal(first.output.join(''), 'A\n', 'only the claimer prints before acknowledgement')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('F: Windows sharing retries are bounded and named without escaping', (t) => {
  const f = fixture(t)
  const result = fresh(f, String.raw`const m=await import(eventUrl);let calls=0;const reasons=[];
    const result=m.appendLauncherEvent('delegate',{key:'A',line:'A'},{...options,platform:'win32',
      link:()=>{calls++;throw Object.assign(new Error('scanner busy'),{code:'EPERM'})},reportReason:line=>reasons.push(line)});
    assert.equal(calls,4,'Windows publication must make exactly four bounded attempts');
    assert.equal(result.ok,false,'exhausted publication must return a named failure');
    assert.match(reasons.join('\n'),/windows-sharing-retry-exhausted.*EPERM/);`)
  assert.equal(result.status, 0)
})

test('G: forced pending-name collision never overwrites either event', (t) => {
  const f = fixture(t), options = { ...f.options, name: () => `${process.pid}-1-forced` }
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, options)
  events.appendLauncherEvent('delegate', { key: 'B', line: 'B' }, options)
  assert.equal(readdirSync(path.join(f.box, 'pending')).length, 2, 'a forced collision must choose a fresh exclusive name')
  const lines = [events.takeLauncherEvent('delegate', f.options)?.line, events.takeLauncherEvent('delegate', f.options)?.line]
  assert.deepEqual(lines.sort(), ['A', 'B'], 'exclusive publication must preserve both payloads')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('a half-written temporary event is invisible to readers', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  writeFileSync(path.join(f.box, 'tmp', `${process.pid}-1-torn.tmp`), '{"key":')
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'A')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('G: two real publishers survive a forced exclusive-name collision', async (t) => {
  const f = fixture(t)
  const body = (key) => `hold();const m=await import(eventUrl);
    const event=m.appendLauncherEvent('delegate',{key:${JSON.stringify(key)},line:${JSON.stringify(key)}},{...options,name:()=> '123-1-forced'});
    assert.equal(event.line,${JSON.stringify(key)},'a colliding publisher must retain its event');`
  const first = await held(t, f, body('A')), second = await held(t, f, body('B'))
  writeFileSync(path.join(f.root, 'release'), 'release')
  await Promise.all([first.ended, second.ended])
  assert.equal(first.child.exitCode, 0); assert.equal(second.child.exitCode, 0)
  const lines = [events.takeLauncherEvent('delegate', f.options)?.line, events.takeLauncherEvent('delegate', f.options)?.line]
  assert.deepEqual(lines.sort(), ['A', 'B'], 'both real publishers must survive without overwriting')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('SIGKILL during a temporary write never publishes torn bytes', async (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const publisher = await held(t, f, String.raw`const write=fs.writeFileSync;
    fs.writeFileSync=(file,data,...args)=>{
      if(typeof file==='number'&&String(data).includes('"key":"B"')){write(file,'{"key":"B"');hold()}
      return write(file,data,...args)};
    syncBuiltinESMExports();const m=await import(eventUrl);m.appendLauncherEvent('delegate',{key:'B',line:'B'},options);`)
  publisher.child.kill('SIGKILL'); await publisher.ended
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'A')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
  events.appendLauncherEvent('delegate', { key: 'C', line: 'C' }, f.options)
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'C')
})

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  for (const phase of ['publish', 'claim', 'acknowledge']) {
    for (const transient of [true, false]) {
      test(`Windows ${code} during ${phase}, transient=${transient}`, (t) => {
        const f = fixture(t), reasons = []; let calls = 0
        const options = { ...f.options, platform: 'win32', reportReason: (line) => { reasons.push(line) } }
        const failure = () => { calls++; if (!transient || calls < 3) throw Object.assign(new Error('sharing failure'), { code }) }
        if (phase === 'publish') {
          const result = fresh(f, `const fsLink=fs.linkSync;const m=await import(eventUrl);let calls=0;const reasons=[];
            const result=m.appendLauncherEvent('delegate',{key:'A',line:'A'},{...options,platform:'win32',
              link:(from,to)=>{calls++;if(!${transient}||calls<3)throw Object.assign(new Error('sharing failure'),{code:${JSON.stringify(code)}});fsLink(from,to)},
              reportReason:line=>{reasons.push(line)}});
            assert.equal(calls,${transient ? 3 : 4});
            assert.equal(result.ok!==false,${transient});
            if(!${transient})assert.match(reasons.join(' '),/windows-sharing-retry-exhausted/);`)
          assert.equal(result.status, 0)
          return
        }
        events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
        options.rename = (from, to) => {
          if ((phase === 'claim' && from.includes(`${path.sep}pending${path.sep}`) && to.includes('claimed-'))
            || (phase === 'acknowledge' && to.includes(`${path.sep}done${path.sep}`))) failure()
          renameSync(from, to)
        }
        const lines = []
        const event = events.takeLauncherEvent('delegate', { ...options, deliver: (item) => { lines.push(item.line) } })
        assert.equal(calls, transient ? 3 : 4)
        assert.equal(Boolean(event), transient || phase === 'acknowledge')
        assert.equal(lines.length, Number(transient || phase === 'acknowledge'))
        if (!transient) assert.match(reasons.join(' '), /windows-sharing-retry-exhausted/)
      })
    }
  }
}
