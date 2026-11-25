import assert from 'node:assert/strict'
import { appendFileSync, existsSync, linkSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { events, fixture, fresh, held, moduleUrl, repo } from './helpers/launcher-fixtures.mjs'

function journalFile(f) {
  const file = path.join(f.box, 'delivery.journal')
  assert.ok(existsSync(file), 'delivery must create a per-launcher journal')
  return file
}
const pendingCount = (f) => readdirSync(path.join(f.box, 'pending')).length
const doneCount = (f) => readdirSync(path.join(f.box, 'done')).length
const publish = (f, key = 'A') => events.appendLauncherEvent('delegate', { key, line: key }, f.options)
const output = (f, lines, extra = {}) => events.takeLauncherEvent('delegate', {
  ...f.options, ...extra, deliver: (event) => { lines.push(event.line) },
})

function fillJournal(f) {
  // Repeat complete acknowledged history to reach the real production threshold,
  // without hundreds of publications or a lowered test-only journal limit.
  const history = readFileSync(journalFile(f))
  const copies = Math.ceil((65_536 - history.length) / history.length)
  if (copies > 0) appendFileSync(journalFile(f), Buffer.concat(Array(copies).fill(history)))
}

async function killAt(t, f, body) {
  const reader = await held(t, f, body)
  reader.child.kill('SIGKILL'); await reader.ended
  return reader.output.join('')
}

test('journal HIGH: EIO with no printed evidence retains the claim until a readable retry', async (t) => {
  const f = fixture(t); publish(f)
  await killAt(t, f, String.raw`const m=await import(eventUrl);
    m.takeLauncherEvent('delegate',{...options,deliver:()=>hold()});`)
  fresh(f, String.raw`const read=fs.readFileSync,open=fs.openSync;let journalFd;
    fs.openSync=(file,...args)=>{const fd=open(file,...args);if(String(file).endsWith('delivery.journal'))journalFd=fd;return fd};
    fs.readFileSync=(file,...args)=>{if(file===journalFd||String(file).endsWith('delivery.journal')||String(file).endsWith('.printed'))
      throw Object.assign(new Error('transient storage failure'),{code:'EIO'});return read(file,...args)};
    syncBuiltinESMExports();const m=await import(eventUrl),reasons=[];
    assert.equal(m.takeLauncherEvent('delegate',{...options,reportReason:r=>reasons.push(r),deliver:()=>assert.fail('unreadable evidence must not print')}),null);
    assert.equal(fs.readdirSync(${JSON.stringify(path.join(f.box, 'done'))}).length,0,'unreadable evidence must never acknowledge an unprinted event');
    assert.match(reasons.join('\n'),/EIO/);`)
  const lines = []; output(f, lines)
  assert.deepEqual(lines, ['A'], 'a readable retry must deliver the retained unprinted claim')
  assert.equal(doneCount(f), 1)
})

test('journal crash: before claim leaves publication available', async (t) => {
  const f = fixture(t)
  events.takeLauncherEvent('delegate', f.options); journalFile(f); publish(f)
  await killAt(t, f, String.raw`const open=fs.openSync;
    fs.openSync=(file,...args)=>{if(String(file).endsWith('delivery.journal'))hold();return open(file,...args)};
    syncBuiltinESMExports();const m=await import(eventUrl);m.takeLauncherEvent('delegate',options);`)
  const lines = []; output(f, lines)
  assert.deepEqual(lines, ['A'], 'death before a claim must deliver once')
})

test('journal crash: after claim and before stdout delivers once', async (t) => {
  const f = fixture(t); publish(f)
  assert.equal(await killAt(t, f, String.raw`const m=await import(eventUrl);
    m.takeLauncherEvent('delegate',{...options,deliver:()=>hold()});`), '')
  assert.equal(pendingCount(f), 1, 'a journal claim must leave its payload in pending')
  const lines = []; output(f, lines); output(f, lines)
  assert.deepEqual(lines, ['A'])
})

test('journal crash: after stdout and before printed has one bounded replay', async (t) => {
  const f = fixture(t); publish(f)
  const first = await killAt(t, f, String.raw`const m=await import(eventUrl);
    m.takeLauncherEvent('delegate',{...options,deliver:item=>{fs.writeSync(1,item.line+'\n');hold()}});`)
  journalFile(f)
  const lines = []; output(f, lines); output(f, lines)
  assert.equal(first, 'A\n'); assert.deepEqual(lines, ['A'], 'one interrupted stdout commit permits one replay')
})

test('journal crash: after printed fsync suppresses replay', async (t) => {
  const f = fixture(t)
  events.takeLauncherEvent('delegate', f.options); journalFile(f); publish(f)
  const first = await killAt(t, f, String.raw`const sync=fs.fsyncSync,open=fs.openSync;let journalFd,appends=0;
    fs.openSync=(file,...args)=>{const fd=open(file,...args);if(String(file).endsWith('delivery.journal'))journalFd=fd;return fd};
    fs.fsyncSync=fd=>{sync(fd);if(fd===journalFd&&++appends===3)hold()};
    syncBuiltinESMExports();const m=await import(eventUrl);
    m.takeLauncherEvent('delegate',{...options,deliver:item=>fs.writeSync(1,item.line+'\n')});`)
  const lines = []; output(f, lines)
  assert.equal(first, 'A\n'); assert.deepEqual(lines, [], 'a durable printed frame must suppress replay')
  assert.equal(doneCount(f), 1)
})

test('journal crash: after done fsync retries projection without stdout', async (t) => {
  const f = fixture(t); publish(f)
  await killAt(t, f, String.raw`const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(String(to).includes(${JSON.stringify(`${path.sep}done${path.sep}`)}))hold();return rename(from,to)};
    syncBuiltinESMExports();const m=await import(eventUrl);m.takeLauncherEvent('delegate',options);`)
  assert.match(readFileSync(journalFile(f), 'utf8'), /"type":"done"/, 'done must be durable before projection')
  const lines = []; output(f, lines)
  assert.deepEqual(lines, []); assert.equal(doneCount(f), 1)
})

test('journal crash: after done projection never reprints', async (t) => {
  const f = fixture(t); publish(f)
  await killAt(t, f, String.raw`const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{rename(from,to);if(String(to).includes(${JSON.stringify(`${path.sep}done${path.sep}`)}))hold()};
    syncBuiltinESMExports();const m=await import(eventUrl);m.takeLauncherEvent('delegate',options);`)
  journalFile(f)
  const lines = []; output(f, lines)
  assert.deepEqual(lines, []); assert.equal(doneCount(f), 1)
})

test('journal torn final record repairs without acknowledgement, then retries the claim', async (t) => {
  const f = fixture(t); publish(f)
  await killAt(t, f, String.raw`const m=await import(eventUrl);
    m.takeLauncherEvent('delegate',{...options,deliver:()=>hold()});`)
  const valid = readFileSync(journalFile(f)); appendFileSync(journalFile(f), '00000080:abc:{"type":"printed"')
  const lines = []; assert.equal(output(f, lines, { reportReason: () => {} }), null, 'a torn journal must retain its claim without delivery')
  assert.equal(doneCount(f), 0, 'a torn record must retain the claim for a subsequent readable retry')
  assert.deepEqual(readFileSync(journalFile(f)), valid, 'repair must retain only checksum-validated frames')
  output(f, lines); assert.deepEqual(lines, ['A'])
})

test('journal checksum mismatch in the interior is retained without any acknowledgement', (t) => {
  const f = fixture(t); publish(f); const lines = []; output(f, lines)
  publish(f, 'B')
  const valid = readFileSync(journalFile(f), 'utf8'), corrupt = valid.replace('"type":"printed"', '"type":"claimxx"')
  writeFileSync(journalFile(f), corrupt)
  assert.equal(output(f, lines, { reportReason: () => {} }), null)
  assert.equal(readFileSync(journalFile(f), 'utf8'), corrupt, 'interior corruption must not be skipped or truncated')
  assert.equal(pendingCount(f), 1); assert.deepEqual(lines, ['A'])
})

test('journal concurrent readers: one writer owns stdout and losing readers do not acknowledge', async (t) => {
  const f = fixture(t); publish(f)
  const first = await held(t, f, String.raw`const m=await import(eventUrl);
    m.takeLauncherEvent('delegate',{...options,deliver:item=>{fs.writeSync(1,item.line+'\n');hold()}});`)
  assert.equal(pendingCount(f), 1, 'the exclusive journal writer must retain the pending payload')
  assert.ok(existsSync(path.join(f.box, 'delivery.writer')), 'concurrent readers require a launcher-wide writer lease')
  const second = fresh(f, String.raw`const m=await import(eventUrl);
    assert.equal(m.takeLauncherEvent('delegate',{...options,deliver:()=>assert.fail('second writer must not print')}),null);`)
  assert.equal(second.stdout, ''); assert.equal(doneCount(f), 0)
  writeFileSync(path.join(f.root, 'release'), 'release'); await first.ended
  assert.equal(first.output.join(''), 'A\n'); assert.equal(doneCount(f), 1)
})

test('journal concurrent dead-owner recovery cannot steal a replacement writer lease', async (t) => {
  const f = fixture(t); publish(f)
  await killAt(t, f, String.raw`const m=await import(eventUrl);m.takeLauncherEvent('delegate',{...options,deliver:()=>hold()});`)
  journalFile(f)
  const body = String.raw`const unlink=fs.unlinkSync;let first=true;
    fs.unlinkSync=file=>{if(first&&String(file).includes('delivery.writer')){first=false;hold()}return unlink(file)};
    syncBuiltinESMExports();const m=await import(eventUrl);
    m.takeLauncherEvent('delegate',{...options,deliver:item=>fs.writeSync(1,item.line+'\n')});`
  const first = await held(t, f, body), second = await held(t, f, body)
  writeFileSync(path.join(f.root, 'release'), 'release'); await Promise.all([first.ended, second.ended])
  assert.equal(first.child.exitCode, 0); assert.equal(second.child.exitCode, 0)
  assert.equal(first.output.join('') + second.output.join(''), 'A\n', 'concurrent reapers must not publish two journal writers')
})

test('journal growth is bounded across repeated compactions and failed output', (t) => {
  const f = fixture(t), lines = []
  publish(f); output(f, lines)
  for (let n = 0; n < 3; n++) {
    fillJournal(f)
    publish(f, `event-${n}`); output(f, lines)
    assert.ok(statSync(journalFile(f)).size <= 65_536 + 3 * 1_099, 'journal must stay below its fixed compaction bound')
    assert.ok(statSync(journalFile(f)).size < 3 * 1_099, 'compaction must discard fully projected history')
  }
  assert.equal(lines.length, 4)
  publish(f, 'retry')
  const fail = () => events.takeLauncherEvent('delegate', { ...f.options, deliver: () => { throw new Error('closed') } })
  assert.throws(fail, /closed/); const size = statSync(journalFile(f)).size
  for (let n = 0; n < 12; n++) assert.throws(fail, /closed/)
  assert.equal(statSync(journalFile(f)).size, size, 'failed unprinted retries must reuse a claim without growing the journal')
  output(f, lines); assert.equal(lines.at(-1), 'retry')
})

test('journal compaction never truncates a hard-linked legacy checkpoint payload', (t) => {
  const f = fixture(t), lines = []; publish(f); output(f, lines); fillJournal(f); publish(f, 'B')
  const payload = path.join(f.box, 'pending', readdirSync(path.join(f.box, 'pending'))[0])
  const before = readFileSync(payload), alias = path.join(f.box, 'delivery.next')
  linkSync(payload, alias)
  output(f, lines, { reportReason: () => {} })
  const retainedPayload = path.join(f.box, 'tmp', `${path.basename(payload, '.json')}.tmp`)
  assert.deepEqual(readFileSync(retainedPayload), before, 'compaction must not truncate a pre-existing hard-linked payload')
  assert.deepEqual(readFileSync(alias), before, 'compaction must leave the legacy checkpoint alias untouched')
  assert.deepEqual(lines, ['A', 'B'], 'a planted checkpoint alias must not prevent delivery')
  assert.equal(doneCount(f), 2)
})

test('journal checkpoint creation rejects a hard link planted at its fresh candidate', (t) => {
  const f = fixture(t), lines = []; publish(f); output(f, lines); fillJournal(f); publish(f, 'B')
  const payload = path.join(f.box, 'pending', readdirSync(path.join(f.box, 'pending'))[0])
  fresh(f, String.raw`const open=fs.openSync,before=fs.readFileSync(${JSON.stringify(payload)});let candidate,flags;
    fs.openSync=(file,value,...args)=>{
      if(/delivery(?:\.[0-9a-f-]{36})?\.next$/.test(String(file))){candidate=file;flags=value;fs.linkSync(${JSON.stringify(payload)},file)}
      return open(file,value,...args)};
    syncBuiltinESMExports();const m=await import(eventUrl),reasons=[];
    assert.equal(m.takeLauncherEvent('delegate',{...options,reportReason:r=>reasons.push(r),deliver:()=>assert.fail('collision must not print')}),null);
    assert.ok(candidate,'compaction must attempt a checkpoint');
    assert.deepEqual(fs.readFileSync(${JSON.stringify(payload)}),before,'exclusive checkpoint creation must preserve a planted hard link');
    assert.deepEqual(fs.readFileSync(candidate),before,'checkpoint collision must leave the planted candidate untouched');
    assert.ok(flags&fs.constants.O_EXCL,'checkpoint creation must use O_EXCL');
    assert.equal(flags&fs.constants.O_TRUNC,0,'checkpoint creation must never use O_TRUNC');
    if(fs.constants.O_NOFOLLOW)assert.ok(flags&fs.constants.O_NOFOLLOW);
    assert.match(reasons.join('\n'),/EEXIST/);`)
  output(f, lines); assert.deepEqual(lines, ['A', 'B'], 'retry must use a different checkpoint name')
})

test('journal parsing reads the validated descriptor after pathname replacement', (t) => {
  const f = fixture(t)
  events.takeLauncherEvent('delegate', f.options)
  fresh(f, String.raw`const file=${JSON.stringify(journalFile(f))},open=fs.openSync,stat=fs.fstatSync,read=fs.readFileSync;let journalFd,validatedFd,seen=false;
    fs.openSync=(source,...args)=>{const fd=open(source,...args);if(source===file)journalFd=fd;return fd};
    fs.fstatSync=fd=>{const info=stat(fd);if(fd===journalFd&&validatedFd===undefined){validatedFd=fd;
      fs.renameSync(file,file+'.validated');fs.writeFileSync(file,'untrusted replacement')}return info};
    fs.readFileSync=(source,...args)=>{if(source===validatedFd){seen=true;return read(source,...args)}
      assert.notEqual(source,file,'journal parsing must not reopen the validated pathname');return read(source,...args)};
    syncBuiltinESMExports();const m=await import(${JSON.stringify(moduleUrl('lib/host/launcher-journal.mjs'))});
    const journal=m.openLauncherJournal({box:${JSON.stringify(f.box)}},options);
    try{assert.ok(seen,'journal parsing must read the fstat-validated descriptor');assert.deepEqual(journal.transactions,[])}
    finally{m.closeLauncherJournal(journal)}`)
})

test('journal documentation scopes recovery proofs and repeated-interruption bounds', () => {
  const design = readFileSync(path.join(repo, 'plugin/skills/external-lane/references/launcher-event-delivery.md'), 'utf8')
  const skill = readFileSync(path.join(repo, 'plugin/skills/external-lane/SKILL.md'), 'utf8')
  for (const text of [design, skill]) {
    assert.match(text, /repeated interruptions[\s\S]*no finite total bound/i, 'delivery contract must not imply a finite lifetime replay bound')
    assert.match(text, /abandoned checkpoints[\s\S]*not bounded/i, 'delivery contract must distinguish journal bytes from abandoned checkpoint storage')
  }
  assert.match(design, /do not enumerate all schedules/i, 'race examples must not be described as exhaustive scheduling proofs')
  assert.match(design, /empty checkpoint/i, 'compaction crash examples must name the checkpoint contents they exercise')
  assert.match(design, /not a power-loss simulation/i, 'process-death tests must not imply hardware durability')
})

for (const phase of ['checkpoint-write', 'before-replace', 'after-replace']) {
  test(`journal compaction crash: ${phase} retains the pending event`, async (t) => {
    const f = fixture(t), lines = []; publish(f); output(f, lines); fillJournal(f); publish(f, 'B')
    const body = String.raw`const open=fs.openSync,write=fs.writeSync,rename=fs.renameSync,sync=fs.fsyncSync;let nextFd;
      fs.openSync=(file,...args)=>{const fd=open(file,...args);if(/delivery(?:\.[0-9a-f-]{36})?\.next$/.test(String(file)))nextFd=fd;return fd};
      fs.fsyncSync=fd=>{if(fd===nextFd&&${JSON.stringify(phase)}==='checkpoint-write'){write(fd,'torn');hold()}sync(fd)};
      fs.renameSync=(from,to)=>{if(String(to).endsWith('delivery.journal')&&${JSON.stringify(phase)}==='before-replace')hold();
        rename(from,to);if(String(to).endsWith('delivery.journal')&&${JSON.stringify(phase)}==='after-replace')hold()};
      syncBuiltinESMExports();const m=await import(eventUrl);m.takeLauncherEvent('delegate',options);`
    assert.equal(await killAt(t, f, body), '')
    output(f, lines); output(f, lines)
    assert.deepEqual(lines, ['A', 'B'], 'compaction interruption must not lose or reannounce an event')
  })
}

test('journal compaction failure refuses new claims until replacement succeeds', (t) => {
  const f = fixture(t), lines = []; publish(f); output(f, lines); fillJournal(f); publish(f, 'B')
  const before = readFileSync(journalFile(f))
  assert.equal(output(f, lines, { reportReason: () => {}, rename: (from, to) => {
    if (to.endsWith('delivery.journal')) throw Object.assign(new Error('checkpoint denied'), { code: 'EACCES' })
    assert.fail(`unexpected rename: ${from}`)
  } }), null)
  assert.deepEqual(readFileSync(journalFile(f)), before, 'failed compaction must retain the complete old journal')
  assert.equal(pendingCount(f), 1); assert.equal(lines.length, 1)
  output(f, lines); assert.deepEqual(lines, ['A', 'B'])
})

test('journal exhausted printed append never substitutes a marker and reports delivery unknown', (t) => {
  const f = fixture(t); publish(f)
  const result = fresh(f, String.raw`const write=fs.writeSync;
    fs.writeSync=(fd,bytes,...args)=>{if(Buffer.isBuffer(bytes)&&bytes.includes(Buffer.from('"type":"printed"')))
      throw Object.assign(new Error('full'),{code:'ENOSPC'});return write(fd,bytes,...args)};
    syncBuiltinESMExports();const {startLauncherWait}=await import(${JSON.stringify(moduleUrl('lib/launcher-wait.mjs'))});
    startLauncherWait('delegate',{...options,timeout:0});`, 1)
  assert.equal(result.stdout, 'A\n'); assert.match(result.stderr, /launcher delivery unknown/)
  assert.equal(doneCount(f), 0, 'no complete printed record means no acknowledgement')
  const lines = []; output(f, lines); output(f, lines)
  assert.deepEqual(lines, ['A'], 'exhausted evidence writes permit one replay for that failed commit')
})

test('journal absence of a deliver callback still completes stdout before acknowledgement', (t) => {
  const f = fixture(t); publish(f)
  const result = fresh(f, String.raw`const m=await import(eventUrl);m.takeLauncherEvent('delegate',options);`)
  assert.equal(result.stdout, 'A\n', 'an event must never be acknowledged without a completed output writer')
  assert.equal(doneCount(f), 1)
})

test('journal projection ENOENT retains evidence when the pending source still exists', (t) => {
  const f = fixture(t), lines = []; publish(f)
  const faults = { reportReason: () => {}, rename: (from, to) => {
    if (to.includes(`${path.sep}done${path.sep}`)) throw Object.assign(new Error('target missing'), { code: 'ENOENT' })
    renameSync(from, to)
  } }
  assert.equal(output(f, lines, faults)?.line, 'A')
  assert.equal(pendingCount(f), 1, 'failed journal projection must retain the pending payload')
  assert.equal(output(f, lines, faults), null, 'ENOENT cannot prove projection while the pending source still exists')
  assert.deepEqual(lines, ['A'], 'an unprojected done record must never reprint')
  assert.equal(output(f, lines), null)
  assert.equal(doneCount(f), 1)
})
