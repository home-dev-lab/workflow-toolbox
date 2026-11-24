import assert from 'node:assert/strict'
import { readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { events, fixture, fresh, held, moduleUrl, repo, scanner } from './helpers/launcher-fixtures.mjs'

test('R1: an unreadable retained link refuses publication until the next sweep', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  events.takeLauncherEvent('delegate', f.options)
  fresh(f, String.raw`const read=fs.readFileSync;let deny=true;const reasons=[];
    fs.readFileSync=(file,...args)=>{if(deny&&String(file).endsWith('.tmp'))throw Object.assign(new Error('denied'),{code:'EACCES'});return read(file,...args)};
    syncBuiltinESMExports();const m=await import(eventUrl);
    const result=m.appendLauncherEvent('delegate',{key:'A',line:'A'},{...options,reportReason:line=>reasons.push(line)});
    assert.equal(result.ok,false,'an incomplete deduplication scan must refuse publication');
    assert.match(result.reason,/launcher-deduplication-incomplete/);
    assert.equal(fs.readdirSync(${JSON.stringify(path.join(f.box, 'pending'))}).length,0);
    deny=false;m.appendLauncherEvent('delegate',{key:'A',line:'A'},options);
    assert.equal(m.takeLauncherEvent('delegate',options),null);`)
})

test('R2: malformed and incomparable birth identities cannot steal a live claim', (t) => {
  const f = fixture(t)
  fresh(f, String.raw`const {hostAdapter:a}=await import(${JSON.stringify(moduleUrl('lib/host/adapter.mjs'))});
    const {readerDead}=await import(${JSON.stringify(moduleUrl('lib/host/launcher-claims.mjs'))});
    const directory=${JSON.stringify(path.join(f.root, 'claim'))};fs.mkdirSync(directory);
    const actual='linux:11111111-2222-3333-4444-555555555555:100';
    a.readProcessExecutionState=()=>({status:'alive'});a.readProcessIdentity=()=>({status:'known',startIdentity:actual});
    for(const startIdentity of [42,{},'', 'garbage', 'snapshot:darwin:123',null]){
      fs.writeFileSync(directory+'/owner.json',JSON.stringify({pid:process.pid,startIdentity}));
      assert.equal(readerDead(directory,{reportReason:()=>{}}),false,'malformed or incomparable identity must mean unknown ownership');
    }
    fs.writeFileSync(directory+'/owner.json','null');
    assert.equal(readerDead(directory,{reportReason:()=>{}}),false);
    fs.writeFileSync(directory+'/owner.json',JSON.stringify({pid:process.pid,startIdentity:actual.replace(':100',':99')}));
    assert.equal(readerDead(directory,options),true,'valid comparable PID reuse must permit recovery');
    a.readProcessIdentity=()=>({status:'unknown'});
    assert.equal(readerDead(directory,{reportReason:()=>{}}),false,'missing boot identity must never authorize recovery');`)
})

test('R3: a normally exiting waiter with exhausted acknowledgement prints only once', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const result = fresh(f, String.raw`const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(String(to).includes(${JSON.stringify(`${path.sep}done${path.sep}`)}))throw Object.assign(new Error('busy'),{code:'EPERM'});return rename(from,to)};
    syncBuiltinESMExports();const {startLauncherWait}=await import(${JSON.stringify(moduleUrl('lib/launcher-wait.mjs'))});
    startLauncherWait('delegate',{...options,platform:'win32',timeout:0});`)
  assert.equal(result.stdout, 'A\n')
  assert.match(result.stderr, /windows-sharing-retry-exhausted/)
  const lines = []
  events.takeLauncherEvent('delegate', { ...f.options, deliver: (event) => { lines.push(event.line) } })
  assert.deepEqual(lines, [], 'successful print followed by normal exit must not replay after acknowledgement failure')
  assert.equal(readdirSync(path.join(f.box, 'done')).length, 1)
})

test('R4: a transient claimed-event read failure is retried by the same sweep process', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A', ownerSessionId: 'session' }, f.options)
  fresh(f, String.raw`const read=fs.readFileSync;let deny=true;
    fs.readFileSync=(file,...args)=>{if(deny&&String(file).includes(${JSON.stringify(`${path.sep}pending${path.sep}`)})&&String(file).endsWith('.json')){deny=false;throw Object.assign(new Error('transient'),{code:'EACCES'})}return read(file,...args)};
    syncBuiltinESMExports();const m=await import(eventUrl);
    assert.equal(m.takeLauncherEvent('delegate',{...options,reportReason:()=>{}}),null);
    assert.equal(m.takeLauncherEvent('delegate',options)?.line,'A','same live sweep must retry the unprinted event after storage recovers');
    assert.equal(m.takeLauncherEvent('delegate',options),null);`)
})

test('R5: two concurrent processes publishing the same logical key reserve it atomically', async (t) => {
  const f = fixture(t)
  // Freeze each publisher at its first link, after both absence scans have completed.
  const body = String.raw`const link=fs.linkSync;let first=true;
    fs.linkSync=(from,to)=>{if(first){first=false;hold()}return link(from,to)};
    syncBuiltinESMExports();const m=await import(eventUrl);
    m.appendLauncherEvent('delegate',{key:'same',line:'same'},options);`
  const first = await held(t, f, body), second = await held(t, f, body)
  writeFileSync(path.join(f.root, 'release'), 'release')
  await Promise.all([first.ended, second.ended])
  assert.equal(first.child.exitCode, 0); assert.equal(second.child.exitCode, 0)
  assert.equal(readdirSync(path.join(f.box, 'pending')).length, 1, 'same-key concurrent publishers must leave exactly one pending event')
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'same')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('R6: acknowledgement is retention-stamped before the done rename can be interrupted', async (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const pending = path.join(f.box, 'pending'), name = readdirSync(pending)[0], old = new Date(0)
  utimesSync(path.join(pending, name), old, old)
  const reader = await held(t, f, String.raw`const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{rename(from,to);if(String(to).includes(${JSON.stringify(`${path.sep}done${path.sep}`)}))hold()};
    syncBuiltinESMExports();const m=await import(eventUrl);m.takeLauncherEvent('delegate',options);`)
  reader.child.kill('SIGKILL'); await reader.ended
  events.appendLauncherEvent('delegate', { key: 'B', line: 'B' }, f.options)
  assert.equal(readdirSync(path.join(f.box, 'done')).length, 1, 'a crash after done rename must not prune a just-acknowledged old event')
})

test('R7: the briefing hard cap explicitly excepts the background launcher waiter', () => {
  for (const directory of ['agent-templates', 'launch-agents/agents']) {
    const text = readFileSync(path.join(repo, 'plugin', directory, 'pilot-orchestrator.md'), 'utf8')
    const rule = text.slice(text.indexOf('If the brief authorizes lane calls'), text.indexOf('On resumption, read'))
    assert.match(rule, /a hard cap, except for the bounded background launcher waiter for lane exits described\s+below/,
      'the briefing hard-cap rule must explicitly except the bounded background launcher waiter')
  }
})

test('unsupported hard links fail closed with a named diagnostic', (t) => {
  const f = fixture(t)
  const result = events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, { ...f.options,
    link: () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }) }, reportReason: () => {} })
  assert.match(result.reason, /launcher-publish-failed: ENOTSUP/)
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('history remains deduplicated throughout the actual one-day eligibility window', (t) => {
  const f = fixture(t), s = scanner(f)
  s.sweep(); events.takeLauncherEvent('delegate', f.options)
  f.options.now += 23 * 3_600_000; s.sweep()
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
  assert.deepEqual(s.lines, [])
})

test('a reserved publication survives publisher death and two concurrent retry helpers', async (t) => {
  const f = fixture(t)
  const body = String.raw`const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(String(from).endsWith('.ready'))hold();return rename(from,to)};
    syncBuiltinESMExports();const m=await import(eventUrl);
    m.appendLauncherEvent('delegate',{key:'same',line:'same'},options);`
  const publisher = await held(t, f, body)
  publisher.child.kill('SIGKILL'); await publisher.ended
  assert.equal(readdirSync(path.join(f.box, 'pending')).length, 0)
  const first = await held(t, f, body), second = await held(t, f, body)
  writeFileSync(path.join(f.root, 'release'), 'release')
  await Promise.all([first.ended, second.ended])
  assert.equal(first.child.exitCode, 0); assert.equal(second.child.exitCode, 0)
  assert.equal(readdirSync(path.join(f.box, 'pending')).length, 1)
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'same')
  events.appendLauncherEvent('delegate', { key: 'same', line: 'same' }, f.options)
  assert.equal(events.takeLauncherEvent('delegate', f.options), null, 'a stale publication helper cannot recreate the consumed source')
})

test('a printed-record write failure cannot report a normally acknowledged waiter exit', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const result = fresh(f, String.raw`const write=fs.writeSync;
    fs.writeSync=(fd,bytes,...args)=>{if(Buffer.isBuffer(bytes)&&bytes.includes(Buffer.from('"type":"printed"')))throw Object.assign(new Error('denied'),{code:'EACCES'});return write(fd,bytes,...args)};
    syncBuiltinESMExports();const {startLauncherWait}=await import(${JSON.stringify(moduleUrl('lib/launcher-wait.mjs'))});
    startLauncherWait('delegate',{...options,timeout:0});`, 1)
  assert.equal(result.stdout, 'A\n')
  assert.match(result.stderr, /launcher delivery unknown/)
})

test('delayed printed-claim recovery starts retention at acknowledgement, not at print', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  fresh(f, String.raw`const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(String(to).includes(${JSON.stringify(`${path.sep}done${path.sep}`)}))throw Object.assign(new Error('busy'),{code:'EPERM'});return rename(from,to)};
    syncBuiltinESMExports();const m=await import(eventUrl);m.takeLauncherEvent('delegate',{...options,deliver:()=>{}});`)
  f.options.now += 8 * 24 * 3_600_000
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
  assert.equal(readdirSync(path.join(f.box, 'done')).length, 1, 'late recovery must retain the newly acknowledged event for another seven days')
})

test('C4 publication: a sweep finishes a reservation after history eligibility expires', (t) => {
  const f = fixture(t)
  const result = events.appendLauncherEvent('delegate', { key: 'old', line: 'old', ownerSessionId: 'session' }, {
    ...f.options, reportReason: () => {}, rename: () => { throw Object.assign(new Error('interrupted'), { code: 'EIO' }) },
  })
  assert.equal(result.ok, false)
  f.options.now += 2 * 24 * 3_600_000
  const s = scanner(f, { store: { load: () => ({ entries: new Map(), baseline: false }),
    records: () => [], reportPresent: () => false } })
  s.sweep()
  assert.equal(readdirSync(path.join(f.box, 'pending')).length, 1, 'the sweep must promote the source before a reader runs')
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'old', 'a reserved source must be delivered without re-appending expired history')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

for (const tail of ['', '00000080:', '00000080:invalid:{"type":"printed"}\n']) {
  test(`journal partial evidence: recovery retains ${JSON.stringify(tail)} before retry`, (t) => {
    const f = fixture(t)
    events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
    fresh(f, String.raw`const m=await import(eventUrl);
      try{m.takeLauncherEvent('delegate',{...options,deliver:()=>{throw new Error('before output')}})}catch{}
      fs.appendFileSync(${JSON.stringify(path.join(f.box, 'delivery.journal'))},${JSON.stringify(tail)});`)
    const reasons = [], lines = []
    const options = { ...f.options, reportReason: (line) => { reasons.push(line) }, deliver: (event) => { lines.push(event.line) } }
    events.takeLauncherEvent('delegate', options)
    if (tail) {
      assert.equal(readdirSync(path.join(f.box, 'done')).length, 0, 'partial evidence cannot acknowledge')
      assert.deepEqual(lines, [])
      assert.match(reasons.join('\n'), /launcher-journal-torn-tail-retained/)
      events.takeLauncherEvent('delegate', options)
    }
    assert.deepEqual(lines, ['A'], 'an unprinted claim must eventually be delivered')
    assert.equal(readdirSync(path.join(f.box, 'done')).length, 1)
  })
}

test('journal evidence failure: exit 1 retains the claim and bounds replay to the failed commit', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const result = fresh(f, String.raw`const write=fs.writeSync;let attempts=0;
    fs.writeSync=(fd,bytes,...args)=>{if(Buffer.isBuffer(bytes)&&bytes.includes(Buffer.from('"type":"printed"'))){attempts++;throw Object.assign(new Error('full'),{code:'ENOSPC'})}return write(fd,bytes,...args)};
    syncBuiltinESMExports();const {startLauncherWait}=await import(${JSON.stringify(moduleUrl('lib/launcher-wait.mjs'))});
    process.on('exit',()=>fs.writeSync(2,'record-attempts='+attempts+'\n'));
    startLauncherWait('delegate',{...options,timeout:0});`, 1)
  assert.equal(result.stdout, 'A\n')
  assert.match(result.stderr, /launcher delivery unknown/)
  const lines = []
  events.takeLauncherEvent('delegate', { ...f.options, deliver: (event) => { lines.push(event.line) } })
  assert.deepEqual(lines, ['A'], 'without complete printed evidence recovery must prefer delivery')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
  assert.match(result.stderr, /record-attempts=3/)
  assert.equal(readdirSync(path.join(f.box, 'done')).length, 1)
})

test('C4 publication: a reader independently finishes an expired reservation', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'old', line: 'old' }, { ...f.options,
    reportReason: () => {}, rename: () => { throw Object.assign(new Error('interrupted'), { code: 'EIO' }) } })
  f.options.now += 2 * 24 * 3_600_000
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'old')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('C4 publication: an unreserved complete source stays invisible to readers', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const base = `${process.pid}-1-unreserved`, directory = path.join(f.box, 'tmp')
  const text = JSON.stringify({ key: 'B', line: 'B', at: f.options.now, name: `${base}.json` })
  writeFileSync(path.join(directory, `${base}.tmp`), text)
  writeFileSync(path.join(directory, `${base}.ready`), text)
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'A')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null, 'recovery must not publish a source before key reservation')
})

test('journal append: partial failures roll back before each bounded retry', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const result = fresh(f, String.raw`const write=fs.writeSync;let attempts=0;
    fs.writeSync=(fd,bytes,...args)=>{if(Buffer.isBuffer(bytes)&&bytes.includes(Buffer.from('"type":"printed"'))){
      attempts++;write(fd,bytes,0,20);throw Object.assign(new Error('full after append'),{code:'ENOSPC'})}return write(fd,bytes,...args)};
    syncBuiltinESMExports();const {startLauncherWait}=await import(${JSON.stringify(moduleUrl('lib/launcher-wait.mjs'))});
    process.on('exit',()=>fs.writeSync(2,'record-attempts='+attempts+'\n'));
    startLauncherWait('delegate',{...options,timeout:0});`, 1)
  assert.equal(result.stdout, 'A\n')
  assert.match(result.stderr, /launcher-journal-append-failed/)
  assert.match(result.stderr, /record-attempts=3/, 'failed appends must have bounded retries')
  assert.doesNotMatch(readFileSync(path.join(f.box, 'delivery.journal'), 'utf8'), /"type":"printed"/,
    'an exhausted partial append must restore the known valid claim boundary')
  const lines = []
  events.takeLauncherEvent('delegate', { ...f.options, deliver: (event) => { lines.push(event.line) } })
  assert.deepEqual(lines, ['A'])
  assert.equal(readdirSync(path.join(f.box, 'done')).length, 1)
  assert.deepEqual(readdirSync(f.box).filter((name) => name.startsWith('claimed-')), [])
})

test('journal append: a transient partial write retries and exits normally', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const result = fresh(f, String.raw`const write=fs.writeSync;let attempts=0;
    fs.writeSync=(fd,bytes,...args)=>{if(Buffer.isBuffer(bytes)&&bytes.includes(Buffer.from('"type":"printed"'))&&++attempts===1){write(fd,bytes,0,20);throw Object.assign(new Error('transient'),{code:'ENOSPC'})}return write(fd,bytes,...args)};
    syncBuiltinESMExports();const {startLauncherWait}=await import(${JSON.stringify(moduleUrl('lib/launcher-wait.mjs'))});
    process.on('exit',()=>{assert.equal(attempts,2)});startLauncherWait('delegate',{...options,timeout:0});`)
  assert.equal(result.stdout, 'A\n')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('journal append: death during a printed frame retains the claim and permits one replay', async (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const reader = await held(t, f, String.raw`const write=fs.writeSync;
    fs.writeSync=(fd,bytes,...args)=>{if(Buffer.isBuffer(bytes)&&bytes.includes(Buffer.from('"type":"printed"'))){write(fd,bytes,0,20);hold()}return write(fd,bytes,...args)};
    syncBuiltinESMExports();const m=await import(eventUrl);m.takeLauncherEvent('delegate',{...options,deliver:item=>fs.writeSync(1,item.line+'\n')});`)
  reader.child.kill('SIGKILL'); await reader.ended
  assert.equal(reader.output.join(''), 'A\n')
  const lines = []
  const options = { ...f.options, reportReason: () => {}, deliver: (event) => { lines.push(event.line) } }
  assert.equal(events.takeLauncherEvent('delegate', options), null, 'repair must retain the claim for a subsequent invocation')
  assert.equal(readdirSync(path.join(f.box, 'done')).length, 0)
  events.takeLauncherEvent('delegate', options)
  assert.deepEqual(lines, ['A'])
  assert.equal(readdirSync(path.join(f.box, 'done')).length, 1)
})

test('journal rollback boundary: failed rollback retains torn evidence and may replay after repair', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const result = fresh(f, String.raw`const write=fs.writeSync;
    fs.writeSync=(fd,bytes,...args)=>{if(Buffer.isBuffer(bytes)&&bytes.includes(Buffer.from('"type":"printed"'))){write(fd,bytes,0,20);throw Object.assign(new Error('denied'),{code:'EACCES'})}return write(fd,bytes,...args)};
    fs.ftruncateSync=()=>{throw Object.assign(new Error('rollback denied'),{code:'EIO'})};
    syncBuiltinESMExports();const {startLauncherWait}=await import(${JSON.stringify(moduleUrl('lib/launcher-wait.mjs'))});
    startLauncherWait('delegate',{...options,timeout:0});`, 1)
  assert.equal(result.stdout, 'A\n')
  assert.match(result.stderr, /launcher-journal-append-failed/)
  assert.match(result.stderr, /launcher delivery unknown/)
  const lines = []
  const options = { ...f.options, reportReason: () => {}, deliver: (event) => { lines.push(event.line) } }
  assert.equal(events.takeLauncherEvent('delegate', options), null)
  assert.deepEqual(lines, [], 'repair cannot acknowledge or print in the torn-tail invocation')
  events.takeLauncherEvent('delegate', options)
  assert.deepEqual(lines, ['A'], 'a retry must deliver when complete evidence never existed')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('journal unreadable printed record: retain until evidence can be read, then acknowledge without replay', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  fresh(f, String.raw`const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(String(to).includes(${JSON.stringify(`${path.sep}done${path.sep}`)}))throw Object.assign(new Error('busy'),{code:'EPERM'});return rename(from,to)};
    syncBuiltinESMExports();const m=await import(eventUrl);m.takeLauncherEvent('delegate',{...options,deliver:()=>{}});`)
  fresh(f, String.raw`const read=fs.readFileSync;const reasons=[];
    fs.readFileSync=(file,...args)=>{if(String(file).endsWith('delivery.journal'))throw Object.assign(new Error('denied'),{code:'EACCES'});return read(file,...args)};
    syncBuiltinESMExports();const m=await import(eventUrl);
    assert.equal(m.takeLauncherEvent('delegate',{...options,reportReason:line=>reasons.push(line),deliver:()=>assert.fail('no replay')}),null);
    assert.match(reasons.join('\n'),/launcher-read-failed.*EACCES/);`)
  assert.equal(readdirSync(path.join(f.box, 'done')).length, 0, 'unreadable evidence must retain the claim')
  assert.equal(events.takeLauncherEvent('delegate', { ...f.options, deliver: () => assert.fail('durable print cannot replay') }), null)
  assert.equal(readdirSync(path.join(f.box, 'done')).length, 1)
})
