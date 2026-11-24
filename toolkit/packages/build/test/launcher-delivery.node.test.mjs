import assert from 'node:assert/strict'
import { test } from 'node:test'
import { events, fixture, fresh, live, routing } from './helpers/launcher-fixtures.mjs'

test('lane orphan output completes fd writes when stream stdout never flushes', (t) => {
  const f = fixture(t); live(f, true)
  const result = fresh(f, String.raw`process.stdout.write=()=>false;
    const r=await import(routingUrl),m=await import(eventUrl);
    r.deliverLauncherRoute(r.routeLauncherEvent(record,{key:'exit',line:'LANE exited'},options),m.printLauncherEvent);
    assert.equal(m.takeLauncherEvent('delegate',options),null);`)
  assert.equal(result.stdout, 'LANE exited launcher-agent=delegate orphaned-launcher=delegate\n')
})

test('synchronous output completes partial UTF-8 writes before acknowledgement', (t) => {
  const f = fixture(t); live(f, true)
  const result = fresh(f, String.raw`const write=fs.writeSync;
    fs.writeSync=(fd,bytes,offset,length)=>write(fd,bytes,offset,Math.min(3,length));syncBuiltinESMExports();
    const r=await import(routingUrl),m=await import(eventUrl);
    r.deliverLauncherRoute(r.routeLauncherEvent(record,{key:'exit',line:'LANE exited π✓'},options),m.printLauncherEvent);
    assert.equal(m.takeLauncherEvent('delegate',options),null);`)
  assert.equal(result.stdout, 'LANE exited π✓ launcher-agent=delegate orphaned-launcher=delegate\n')
})

for (const output of ['throwing', 'buffered', 'async']) {
  test(`${output} lane completion output leaves its event pending`, (t) => {
    const f = fixture(t); live(f, true)
    const writer = output === 'throwing' ? () => { throw new Error('output closed') } : output === 'buffered' ? () => false : () => Promise.resolve()
    const route = routing.routeLauncherEvent(f.record, { key: 'exit', line: 'LANE exited' }, f.options)
    assert.throws(() => routing.deliverLauncherRoute(route, writer), /output closed|synchronous/)
    assert.match(events.takeLauncherEvent('delegate', f.options)?.line, /LANE exited/)
  })
}

test('a waiter killed after print but before acknowledge replays once', async (t) => {
  const { held } = await import('./helpers/launcher-fixtures.mjs')
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
  const reader = await held(t, f, String.raw`const m=await import(eventUrl);
    m.takeLauncherEvent('delegate',{...options,deliver:item=>{fs.writeSync(1,item.line+'\n');hold()}});`)
  reader.child.kill('SIGKILL'); await reader.ended
  assert.equal(reader.output.join(''), 'A\n')
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'A')
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})
