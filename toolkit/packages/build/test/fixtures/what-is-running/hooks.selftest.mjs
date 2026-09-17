import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hooksModule from '../../../../../../plugin/hooks/hooks.js';
import * as artifactHelpers from '../../../../../../plugin/hooks/snapshot-program.js';
import { PHASES } from '../../../../../../plugin/bin/lib/lifecycle-state-machine.mjs';
import { captureHasPane } from './host-capture-match.mjs';

const { readSnapshot, register } = hooksModule;
const hookDir = fileURLToPath(new URL('.', import.meta.url));
const pluginRoot = fileURLToPath(new URL('../../../../../../plugin/', import.meta.url));
const renderPropsSnapshot = JSON.parse(readFileSync(join(hookDir, 'render-props.snapshot.json'), 'utf8'));

function declaredKeys(source, typeName) {
  const match = source.match(new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`));
  assert(match, `${typeName} declaration missing`);
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '');
  return [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\??\s*:/gm)].map((item) => item[1]).sort();
}

function parsedRenderProps(source) {
  const textHover = declaredKeys(source, 'TextHoverProps');
  return {
    Box: { props: declaredKeys(source, 'BoxProps'), hover: declaredKeys(source, 'BoxHoverProps') },
    Text: { props: declaredKeys(source, 'TextProps'), hover: textHover },
    Button: { props: declaredKeys(source, 'ButtonProps'), hover: textHover },
    Link: { props: declaredKeys(source, 'LinkProps') },
  };
}

function validateElementProps(name, props) {
  const schema = renderPropsSnapshot[name];
  for (const key of Object.keys(props)) {
    if (key !== 'children') assert(schema.props.includes(key), `${name}.${key} is not declared`);
  }
  if (props.hover) for (const key of Object.keys(props.hover)) {
    assert(schema.hover?.includes(key), `${name}.hover.${key} is not declared`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'wt-wir-'));
const configDir = join(root, 'config');
const livenessDir = join(root, 'liveness');
const suiteRoot = join(root, 'suite');
const procRoot = join(root, 'proc');
const plankaConfigFile = join(root, 'planka.env');
const worktree = join(suiteRoot, 'worktrees', 'card-one');
const sdkRunning = join(suiteRoot, 'worktrees', 'sdk-running');
const sdkPartial = join(suiteRoot, 'worktrees', 'sdk-partial');
const waveId = 'fixture-wave';
const waveCardId = '1862698281071544160';
const liteCardId = '1862698281071544161';
const waveDir = join(suiteRoot, 'worktrees', `wave-${waveId}`);
const waveWorktree = join(suiteRoot, 'worktrees', `card-${waveCardId}-wave-${waveId}`);
const liteWorktree = join(suiteRoot, 'worktrees', 'standalone-lite');
mkdirSync(join(configDir, 'plugins', 'store'), { recursive: true });
mkdirSync(join(configDir, 'plugins', 'data', 'workflow-toolbox-inline', 'spawn-registry'), { recursive: true });
mkdirSync(livenessDir, { recursive: true });
mkdirSync(join(worktree, '.lane'), { recursive: true });
mkdirSync(join(worktree, '.claude', 'reports'), { recursive: true });
writeFileSync(join(configDir, 'plugins', 'store', 'wt-lifecycle-hooks_inline-fixture.json'), JSON.stringify({
  'card.1862698281071544189': { phase: 'verify', next: 'wait for test', at: '2026-09-12T12:00:00Z' },
}));
writeFileSync(join(configDir, 'plugins', 'data', 'workflow-toolbox-inline', 'spawn-registry', 'session.jsonl'), [
  { t: 'spawn', child: 'agent-old', childName: 'pilot-one', name: 'pilot-one', parentName: 'pilot', purpose: 'card 1862698281071544189', model: 'claude-sonnet-5', at: '2026-09-12T11:00:00Z' },
  { t: 'stop', agentId: 'agent-old', name: 'general-purpose', at: '2026-09-12T11:30:00Z' },
  { t: 'spawn', child: 'agent-1', childName: 'pilot-one', name: 'pilot-one', parentName: 'pilot', purpose: 'card 1862698281071544189', model: 'claude-opus-5', at: '2026-09-12T12:00:00Z' },
].map(JSON.stringify).join('\n') + '\n');
writeFileSync(join(worktree, '.lane', 'brief.md'), '# Brief: card 1862698281071544189: Ship the artifact server\n');
writeFileSync(join(worktree, '.lane', 'run.log'), 'working\n');
writeFileSync(join(worktree, '.lane', 'test.log'), 'Tests 21 passed\nEXIT=0\n');
writeFileSync(join(worktree, '.lane', 'typecheck.log'), 'error\nEXIT=2\n');
writeFileSync(join(worktree, '.lane', 'report.md'), '## Verification\nreview decision: changes requested\n');
writeFileSync(join(worktree, '.claude', 'reports', 'pr-review.md'), 'lenses run: security, tests\nopen findings: 2\ndecision: changes requested\n');
writeFileSync(join(worktree, 'usage.json'), JSON.stringify({ model: 'claude-opus-5', input_tokens: 120, output_tokens: 30 }));
writeFileSync(join(livenessDir, 'agent-1.json'), JSON.stringify({
  agentId: 'agent-1', agentIdSource: 'brief', scope: 'card:1862698281071544189', complete: false,
  waitingOn: 'spawner', worktree, updatedAt: '2026-09-12T11:00:00Z',
}));
mkdirSync(join(sdkRunning, '.lane'), { recursive: true });
writeFileSync(join(sdkRunning, '.lane', 'route.json'), JSON.stringify({ cardId: '1862698281071544190' }));
writeFileSync(join(sdkRunning, '.lane', 'runner-stdout.log'), [
  'lifecycle: accepted phase=plan',
  'lifecycle: lane critic EXIT=0',
  'lifecycle: accepted phase=critic',
  'lifecycle: lane critic EXIT=2',
  'lifecycle: accepted phase=plan',
  'lifecycle: accepted phase=critic',
  'lifecycle: accepted phase=tdd',
  'lifecycle: accepted phase=verify',
  'lifecycle: accepted phase=review',
  'lifecycle: accepted phase=refutation',
  'lifecycle: accepted phase=harden',
  'lifecycle: accepted phase=verify',
  'lifecycle: accepted phase=review',
  'lifecycle: accepted phase=refutation',
  'lifecycle: accepted phase=report',
  'lifecycle: accepted phase=awaiting_fidelity',
].join('\n') + '\n');
writeFileSync(join(sdkRunning, '.lane', 'usage.json'), JSON.stringify({
  totals: { input: 10, output: 20, cache_creation: 30, cache_read: 40 },
  turns: [{ input: 999, output: 999 }],
}));
mkdirSync(join(sdkPartial, '.lane'), { recursive: true });
writeFileSync(join(sdkPartial, '.lane', 'card.md'), '# SDK fallback card\n\nCard id: 1862698281071544191\n');
writeFileSync(join(sdkPartial, '.lane', 'runner-stdout.log'), 'lifecycle: accepted phase=awaiting_fidelity\nEXIT=2\n');
mkdirSync(join(waveDir, 'cards', waveCardId), { recursive: true });
writeFileSync(join(waveDir, 'cards', waveCardId, 'card.md'), `# card ${waveCardId} — Wave pilot\n\nCard id: ${waveCardId}\n`);
mkdirSync(join(waveWorktree, '.lane'), { recursive: true });
writeFileSync(join(waveWorktree, '.lane', 'route.json'), JSON.stringify({ cardId: waveCardId, route: 'FULL' }));
writeFileSync(join(waveWorktree, '.lane', 'runner-stdout.log'), [
  'lifecycle: accepted phase=discovery',
  'lifecycle: accepted phase=plan',
  'lifecycle: lane critic EXIT=2',
  'lifecycle: accepted phase=critic',
].join('\n') + '\n');
writeFileSync(join(waveWorktree, '.lane', 'pid'), String(process.pid));
writeFileSync(join(waveWorktree, '.lane', 'plan.md'), [
  '# Plan', '## ADR', '### Decision', 'Use a bounded tree.', 'Keep refresh state.',
  '## Tasks', '1. **Build hierarchy.** Nest every actor.', '2. Test inspector',
].join('\n') + '\n');
writeFileSync(join(waveWorktree, '.lane', 'critic-report.round-1.md'), [
  'VERDICT: changes-requested', 'FINDINGS:', '- Superseded finding',
].join('\n') + '\n');
writeFileSync(join(waveWorktree, '.lane', 'critic-report.round-2.md'), [
  'VERDICT: approved', 'FINDINGS:', '- First finding summary', '  continuation hidden', '- Second finding',
].join('\n') + '\n');
writeFileSync(join(waveWorktree, '.lane', 'pilot-report.md'), [
  '# Pilot report', '## Implemented', 'Nested layout shipped.', '', 'More detail.', '## Verification', 'All checks pass.',
].join('\n') + '\n');
mkdirSync(join(procRoot, String(process.pid)), { recursive: true });
writeFileSync(join(procRoot, String(process.pid), 'cmdline'), `wt-lane\0${waveWorktree}\0`);
symlinkSync(waveWorktree, join(procRoot, String(process.pid), 'cwd'));
mkdirSync(join(liteWorktree, '.lane'), { recursive: true });
writeFileSync(join(liteWorktree, '.lane', 'route.json'), JSON.stringify({ cardId: liteCardId, route: 'LITE' }));
writeFileSync(join(liteWorktree, '.lane', 'runner-stdout.log'), 'lifecycle: accepted phase=discovery\nlifecycle: accepted phase=tdd\n');

writeFileSync(plankaConfigFile, 'BASE_URL=http://localhost:3000\n');
const paths = { configDir, livenessDir, suiteRoot, procRoot, plankaConfigFile, now: '2026-09-12T12:30:00Z' };
const processCapability = {
  run: async (argv) => {
    const stdout = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' });
    return { exitCode: 0, stdout, stderr: '' };
  },
};
const failures = [];
let testCount = 0;
const testFilter = process.env.WT_WIR_SELFTEST_FILTER;
let finishedOnlySnapshot;
let cappedDiscoverySnapshot;
let structuredLifecycleSnapshot;
async function test(name, fn) {
  if (testFilter && !name.includes(testFilter)) return;
  testCount += 1;
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error.message}`); }
}

await test('[blank pane fix schema lock] checked-in render props match the installed host declarations', async () => {
  for (const component of Object.values(renderPropsSnapshot)) {
    assert.deepEqual(component.props, [...component.props].sort());
    if (component.hover) assert.deepEqual(component.hover, [...component.hover].sort());
  }
  const declaration = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'marketplaces', 'claude-code-plugins', 'mods', 'types', 'claude-code.d.ts');
  if (existsSync(declaration)) assert.deepEqual(parsedRenderProps(readFileSync(declaration, 'utf8')), renderPropsSnapshot);
});

await test('stale liveness metadata is ignored when a fresh worktree keeps the row live', async () => {
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  const row = snapshot.rows.find((item) => item.id === '1862698281071544189');
  assert.match(row.activity, /^last write \d+ min ago$/);
  assert.equal(row.kind, 'external');
});
await test('worktree activity does not require liveness', async () => {
  rmSync(join(livenessDir, 'agent-1.json'));
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  const row = snapshot.rows.find((item) => item.id === '1862698281071544189');
  assert.match(row.activity, /^last write \d+ min ago$/);
  assert.equal(row.kind, 'external');
});
await test('[Step 4 URL discovery] configured and discovered Planka bases resolve the 2.1.1 card route', async () => {
  const pluginFile = join(pluginRoot, '.claude-plugin', 'plugin.json');
  const userConfig = JSON.parse(readFileSync(pluginFile, 'utf8')).userConfig;
  assert.equal(userConfig.plankaBaseUrl.default, '');
  // Claude Code's manifest validator rejects a userConfig of type "array" and then refuses to load the whole plugin
  // (measured 2026-09-13: `claude plugin validate --strict` -> "userConfig.extraRoots.type: Invalid input", /wir unknown).
  assert.equal(userConfig.extraRoots.type, 'string');
  assert.equal(userConfig.extraRoots.default, '');
  for (const [key, option] of Object.entries(userConfig)) {
    assert.ok(['string', 'number', 'boolean'].includes(option.type), `userConfig.${key}.type ${option.type} is not a type the host validator accepts`);
  }
  const discovered = await readSnapshot({ process: processCapability }, paths);
  assert.equal(discovered.rows.find((row) => row.cardId === '1862698281071544189').cardUrl, 'http://localhost:3000/cards/1862698281071544189');
  const configured = await readSnapshot({ process: processCapability }, { ...paths, plankaBaseUrl: 'https://boards.example.test/' });
  assert.equal(configured.rows.find((row) => row.cardId === '1862698281071544189').cardUrl, 'https://boards.example.test/cards/1862698281071544189');
});
await test('[Step 4 URL discovery] absent Planka base leaves card URLs absent', async () => {
  const snapshot = await readSnapshot({ process: processCapability }, { ...paths, plankaConfigFile: join(root, 'missing-planka.env') });
  assert.equal(snapshot.rows.find((row) => row.cardId === '1862698281071544189').cardUrl, null);
});
await test('[Step 4 title cleanup] matching card prefixes are removed from external and pilot titles', async () => {
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  assert.equal(snapshot.rows.find((row) => row.cardId === '1862698281071544189').title, 'Ship the artifact server');
  assert.equal(snapshot.rows.find((row) => row.id === waveCardId).title, 'Wave pilot');
});
await test('[changed Round 3 terminal state][A-1][E-1] finished SDK runs leave the live snapshot', async () => {
  const completed = join(suiteRoot, 'worktrees', 'sdk-completed');
  const failed = join(suiteRoot, 'worktrees', 'sdk-failed');
  for (const [dir, id, exit] of [
    [completed, '1862698281071544192', 0],
    [failed, '1862698281071544193', 7],
  ]) {
    mkdirSync(join(dir, '.lane'), { recursive: true });
    writeFileSync(join(dir, '.lane', 'route.json'), JSON.stringify({ cardId: id }));
    writeFileSync(join(dir, '.lane', 'runner-stdout.log'), `lifecycle: accepted phase=report\nEXIT=${exit}\n`);
  }
  const isolated = join(root, 'finished-only');
  const isolatedPaths = {
    configDir: join(isolated, 'config'),
    livenessDir: join(isolated, 'liveness'),
    suiteRoot: join(isolated, 'suite'),
    now: paths.now,
  };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const terminal = join(isolatedPaths.suiteRoot, 'worktrees', 'terminal');
  mkdirSync(join(terminal, '.lane'), { recursive: true });
  writeFileSync(join(terminal, '.lane', 'route.json'), JSON.stringify({ cardId: '1862698281071544194' }));
  writeFileSync(join(terminal, '.lane', 'runner-stdout.log'), 'lifecycle: accepted phase=report\nEXIT=0\n');
  finishedOnlySnapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.deepEqual(finishedOnlySnapshot.rows, []);

  const snapshot = await readSnapshot({ process: processCapability }, paths);
  assert.equal(snapshot.rows.find((row) => row.id === '1862698281071544190').outcome, 'waiting for arbiter review');
  for (const id of ['1862698281071544191', '1862698281071544192', '1862698281071544193']) {
    assert(!snapshot.rows.some((row) => row.id === id));
  }
});
await test('[DoD 2] empty SDK log does not suppress a fresh external lane', async () => {
  const isolated = join(root, 'legacy-fallback');
  const isolatedPaths = {
    configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'),
    suiteRoot: join(isolated, 'suite'), now: paths.now,
  };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const legacy = join(isolatedPaths.suiteRoot, 'worktrees', 'legacy');
  mkdirSync(join(legacy, '.lane'), { recursive: true });
  writeFileSync(join(legacy, '.lane', 'runner-stdout.log'), '');
  writeFileSync(join(legacy, '.lane', 'run.log'), 'working\n');
  writeFileSync(join(legacy, '.lane', 'brief.md'), '# Brief for card 1862698281071544176\n');
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const row = snapshot.rows.find((item) => item.id === '1862698281071544176');
  assert.equal(row?.outcome, 'running');
  assert.equal(row?.kind, 'external');
});
await test('[Missed card-id collision] running lane wins in both directory orders', async () => {
  const id = '1862698281071544177';
  for (const [caseName, runningName, finishedName] of [
    ['running-first', 'a-running', 'z-finished'],
    ['running-last', 'z-running', 'a-finished'],
  ]) {
    const isolated = join(root, `collision-${caseName}`);
    const isolatedPaths = {
      configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'),
      suiteRoot: join(isolated, 'suite'), now: paths.now,
    };
    mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
    mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
    mkdirSync(isolatedPaths.livenessDir, { recursive: true });
    for (const [name, exit] of [[runningName, null], [finishedName, 0]]) {
      const dir = join(isolatedPaths.suiteRoot, 'worktrees', name);
      mkdirSync(join(dir, '.lane'), { recursive: true });
      writeFileSync(join(dir, '.lane', 'route.json'), JSON.stringify({ cardId: id }));
      writeFileSync(join(dir, '.lane', 'runner-stdout.log'), `lifecycle: accepted phase=tdd\n${exit === null ? '' : `EXIT=${exit}\n`}`);
    }
    const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
    assert.equal(snapshot.rows.find((row) => row.id === id)?.outcome, 'running');
  }
});
await test('[A-1][B-1] SDK phase map uses every authoritative lifecycle phase', async () => {
  assert.deepEqual(hooksModule.PANE_PHASES.map(([phase]) => phase), PHASES);
  assert(hooksModule.PANE_PHASES.every(([, label]) => typeof label === 'string' && label.length > 0));
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  const running = snapshot.rows.find((row) => row.id === '1862698281071544190');
  assert.equal(running.phase, 'awaiting_fidelity');
  assert.equal(running.criticRounds, 2);

  const phaseCases = [...PHASES, 'awaiting_fidelity'];
  for (const [index, emitted] of phaseCases.entries()) {
    const dir = join(suiteRoot, 'worktrees', `sdk-phase-${emitted}`);
    const id = String(1862698281071544100n + BigInt(index));
    mkdirSync(join(dir, '.lane'), { recursive: true });
    writeFileSync(join(dir, '.lane', 'route.json'), JSON.stringify({ cardId: id }));
    writeFileSync(join(dir, '.lane', 'runner-stdout.log'), `lifecycle: accepted phase=${emitted}\n`);
  }
  const phases = await readSnapshot({ process: processCapability }, paths);
  for (const [index, expected] of phaseCases.entries()) {
    const id = String(1862698281071544100n + BigInt(index));
    assert.equal(phases.rows.find((row) => row.id === id).phase, expected);
  }
});
await test('[lifecycle source] structured timeline wins over log fallback and drives rendered stages', async () => {
  const isolated = join(root, 'structured-lifecycle');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const cardId = '1862698281071544149';
  const dir = join(isolatedPaths.suiteRoot, 'worktrees', 'timeline');
  mkdirSync(join(dir, '.lane'), { recursive: true });
  writeFileSync(join(dir, '.lane', 'route.json'), JSON.stringify({ cardId, route: 'LITE' }));
  writeFileSync(join(dir, '.lane', 'card.md'), `# Structured lifecycle ${cardId}\n`);
  writeFileSync(join(dir, '.lane', 'runner-stdout.log'), 'lifecycle: accepted phase=plan\n');
  writeFileSync(join(dir, '.lane', 'lifecycle.json'), JSON.stringify({
    version: 2, started_at: 1, ended_at: null,
    phases: [
      { phase: 'discovery', round: null, entered_at: 1, exited_at: 2 },
      { phase: 'tdd', round: null, entered_at: 2, exited_at: 3 },
      { phase: 'verify', round: null, entered_at: 3, exited_at: null },
    ],
  }));
  structuredLifecycleSnapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const row = structuredLifecycleSnapshot.rows.find((item) => item.id === cardId);
  assert.equal(row.phase, 'verify');
  assert.equal(row.phaseSource, 'lifecycle');
  assert.equal(row.phaseStates.discovery, 'done');
  assert.equal(row.phaseStates.tdd, 'done');
  assert.equal(row.phaseStates.verify, 'running');
});
await test('[changed Round 3 terminal state][A-2][incorrect completion] accepted history preserves loops and marks jumps skipped', async () => {
  const jump = join(suiteRoot, 'worktrees', 'sdk-jump-report');
  mkdirSync(join(jump, '.lane'), { recursive: true });
  writeFileSync(join(jump, '.lane', 'route.json'), JSON.stringify({ cardId: '1862698281071544175', route: 'FULL' }));
  writeFileSync(join(jump, '.lane', 'runner-stdout.log'), [
    'lifecycle: accepted phase=plan',
    'lifecycle: accepted phase=critic',
    'lifecycle: accepted phase=plan',
    'lifecycle: accepted phase=critic',
    'lifecycle: accepted phase=report',
  ].join('\n') + '\n');
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  const loop = snapshot.rows.find((row) => row.id === '1862698281071544190');
  assert.equal(loop.phaseStates.critic, 'done');
  assert.equal(loop.phaseStates.harden, 'done');
  assert.equal(loop.phaseStates.awaiting_fidelity, 'waiting for arbiter review');
  const skipped = snapshot.rows.find((row) => row.id === '1862698281071544175');
  assert.equal(skipped.phaseStates.plan, 'done');
  assert.equal(skipped.phaseStates.critic, 'done');
  assert.equal(skipped.phaseStates.tdd, 'skipped');
  assert.equal(skipped.phaseStates.verify, 'skipped');
  assert.equal(skipped.phaseStates.report, 'running');
  assert.equal(skipped.phaseStates.awaiting_fidelity, 'not started');
});
await test('SDK usage reads only the four usage.json totals', async () => {
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  assert.deepEqual(snapshot.rows.find((row) => row.id === '1862698281071544190').usage, {
    input: 10, output: 20, cacheCreation: 30, cacheRead: 40,
  });
});
await test('[regression] current SDK runner files produce a live pilot card', async () => {
  const isolated = join(root, 'current-sdk-runner');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', clockTicks: 100 };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const cardId = '1862698281071544150';
  const runnerPid = '320';
  const lanePid = '321';
  const worktree = join(isolatedPaths.suiteRoot, 'worktrees', 'sdk-current');
  const lane = join(worktree, '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'FULL', reasons: ['effort >= M', 'type feature'], executor: 'gpt-lane', models: { critic: 'openai/gpt-5.6-sol', code: 'openai/gpt-5.6-sol', review: 'openai/gpt-5.6-sol', refutation: 'openai/gpt-6-astra' }, base: 'fixture-base' }));
  writeFileSync(join(lane, 'sdk-pilot.log'), [
    'route=FULL reasons=effort >= M,type feature model=opus effective=opus executor=gpt-lane',
    'lifecycle: accepted phase=plan',
    'lifecycle: edge refused: plan->critic; missing valid plan artifact',
    'lifecycle: accepted phase=critic',
  ].join('\n') + '\n');
  writeFileSync(join(lane, 'pid'), lanePid);
  mkdirSync(isolatedPaths.procRoot, { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, 'uptime'), '20000.00 1000.00\n');
  mkdirSync(join(isolatedPaths.procRoot, runnerPid), { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, runnerPid, 'status'), 'Name:\tnode\nPPid:\t1\n');
  writeFileSync(join(isolatedPaths.procRoot, runnerPid, 'cmdline'), ['node', '/plugin/bin/wt-pilot-runner.mjs', '--card', cardId, '--card-file', join(lane, 'card.md'), '--dir', worktree, '--knowledge-base-index', '/fixture/knowledge.md', '--timeout', '5400'].join('\0') + '\0');
  writeFileSync(join(isolatedPaths.procRoot, runnerPid, 'stat'), `${runnerPid} (node) S 1 ${Array(17).fill('0').join(' ')} 1880000\n`);
  mkdirSync(join(isolatedPaths.procRoot, lanePid), { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, lanePid, 'status'), `Name:\tnode\nPPid:\t${runnerPid}\n`);
  writeFileSync(join(isolatedPaths.procRoot, lanePid, 'cmdline'), ['node', '/plugin/bin/wt-lane.mjs', '--worker', '--dir', worktree, '--model', 'openai/gpt-5.6-sol', '--brief', join(lane, 'critic-brief.md'), '--timeout', '5400'].join('\0') + '\0');
  writeFileSync(join(isolatedPaths.procRoot, lanePid, 'stat'), `${lanePid} (node) S ${runnerPid} ${Array(17).fill('0').join(' ')} 1994000\n`);

  const row = (await readSnapshot({ process: processCapability }, isolatedPaths)).rows.find((item) => item.id === cardId);
  assert.equal(row.route, 'FULL');
  assert.equal(row.model, 'opus');
  assert.equal(row.phase, 'critic');
  assert.equal(row.elapsed, '20 min');
  assert.equal(row.lanes.length, 1);
  assert.equal(row.lanes[0].label, 'Critic lane');
  assert.equal(row.lanes[0].model, 'openai/gpt-5.6-sol');
  // A detached runner (PPid 1, no launcher session) under the suite worktrees belongs to the suite project, so the
  // default project scope shows it instead of hiding it as unattributed.
  assert.equal(row.project, 'current-sdk-runner');

  writeFileSync(join(lane, 'sdk-pilot.log'), readFileSync(join(lane, 'sdk-pilot.log'), 'utf8') + 'EXIT=0\n');
  assert(!(await readSnapshot({ process: processCapability }, isolatedPaths)).rows.some((item) => item.id === cardId));
});
await test('[A-2] truncated SDK history is explicitly marked', async () => {
  const truncated = join(suiteRoot, 'worktrees', 'sdk-truncated');
  mkdirSync(join(truncated, '.lane'), { recursive: true });
  writeFileSync(join(truncated, '.lane', 'route.json'), JSON.stringify({ cardId: '1862698281071544178' }));
  writeFileSync(join(truncated, '.lane', 'runner-stdout.log'), `lifecycle: accepted phase=plan\n${'x'.repeat(70_000)}\nlifecycle: lane critic EXIT=0\n`);
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  const row = snapshot.rows.find((item) => item.id === '1862698281071544178');
  assert.equal(row.phase, 'unknown');
  assert.equal(row.criticRounds, 1);
  assert.equal(row.runnerLogTruncated, true);
});
await test('[Missed zero rounds] SDK snapshots preserve a zero critic count', async () => {
  const zero = join(suiteRoot, 'worktrees', 'sdk-zero-rounds');
  mkdirSync(join(zero, '.lane'), { recursive: true });
  writeFileSync(join(zero, '.lane', 'route.json'), JSON.stringify({ cardId: '1862698281071544179' }));
  writeFileSync(join(zero, '.lane', 'runner-stdout.log'), 'lifecycle: accepted phase=plan\n');
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  assert.equal(snapshot.rows.find((row) => row.id === '1862698281071544179').criticRounds, 0);
});
await test('unreadable discovery is unknown while readable empty discovery is empty', async () => {
  const unavailable = await readSnapshot({ process: processCapability }, { ...paths, livenessDir: join(root, 'missing-liveness') });
  assert.equal(unavailable.discovery, 'unknown');
  const emptyRoot = join(root, 'empty');
  const emptyPaths = {
    configDir: join(emptyRoot, 'config'),
    livenessDir: join(emptyRoot, 'liveness'),
    suiteRoot: join(emptyRoot, 'suite'),
    now: paths.now,
  };
  mkdirSync(join(emptyPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(emptyPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(emptyPaths.livenessDir, { recursive: true });
  mkdirSync(join(emptyPaths.suiteRoot, 'worktrees'), { recursive: true });
  mkdirSync(join(emptyPaths.suiteRoot, 'reports'), { recursive: true });
  const empty = await readSnapshot({ process: processCapability }, emptyPaths);
  assert.equal(empty.discovery, 'available');
  assert.deepEqual(empty.rows, []);
});
await test('brief body card is not lane ownership', async () => {
  const other = join(suiteRoot, 'worktrees', 'other-card');
  mkdirSync(join(other, '.lane'), { recursive: true });
  writeFileSync(join(other, '.lane', 'brief.md'), '# Notes for linked work\n\n# Brief follow-up card 1862698281071544196\n');
  writeFileSync(join(other, '.lane', 'run.log'), 'working\n');
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  assert(!snapshot.rows.some((row) => row.id === '1862698281071544196'));
});
await test('fresh lifecycle-only cards are included and completed records are excluded', async () => {
  writeFileSync(join(configDir, 'plugins', 'store', 'wt-lifecycle-hooks_inline-fixture.json'), JSON.stringify({
    'card.1862698281071544189': { phase: 'verify' },
    'card.1862698281071544197': { phase: 'tdd' },
    'card.1862698281071544198': { phase: 'complete' },
  }));
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  assert(snapshot.rows.some((row) => row.id === '1862698281071544197'));
  assert(!snapshot.rows.some((row) => row.id === '1862698281071544198'));
});
await test('[R3] real terminal lifecycle shapes are excluded despite a fresh store', async () => {
  const isolated = join(root, 'terminal-lifecycle-shapes');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: '2026-09-12T12:30:00Z' };
  const storeDir = join(isolatedPaths.configDir, 'plugins', 'store');
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const storeFile = join(storeDir, 'wt-lifecycle-hooks_real-shapes.json');
  writeFileSync(storeFile, JSON.stringify({
    'card.1860382457463834502': { at: '2026-09-12T12:25:00Z', phase: 'COMPLETE.', next: "Frederic's go on the implementation card(s)." },
    'card.1860379314411800448': { at: '2026-09-12T12:25:00Z', phase: 'COMPLETE (with the two open items named).', next: 'restart-dependent precision measurement; heredoc follow-up if it fires again.' },
    'card.1860387857420519311': { at: '2026-09-12T12:25:00Z', phase: 'COMPLETE.', next: 'none on this card; the Node 20 question goes to the CI matrix check at the next release.' },
    'card.1862698281071544108': { at: '2026-09-12T12:25:00Z', phase: 'done:' },
  }));
  utimesSync(storeFile, new Date('2026-09-12T12:29:00Z'), new Date('2026-09-12T12:29:00Z'));
  assert.deepEqual((await readSnapshot({ process: processCapability }, isolatedPaths)).rows, []);
});
await test('[R3] an old record in a recently-written lifecycle store is not live', async () => {
  const isolated = join(root, 'record-freshness');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: '2026-09-12T12:30:00Z' };
  const storeDir = join(isolatedPaths.configDir, 'plugins', 'store');
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const storeFile = join(storeDir, 'wt-lifecycle-hooks_mixed.json');
  writeFileSync(storeFile, JSON.stringify({
    'card.1862698281071544107': { phase: 'plan', at: '2026-09-12T12:00:00Z' },
    'card.1862698281071544106': { phase: 'tdd', at: '2026-09-12T12:25:00Z' },
  }));
  utimesSync(storeFile, new Date('2026-09-12T12:29:00Z'), new Date('2026-09-12T12:29:00Z'));
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert(!snapshot.rows.some((row) => row.id === '1862698281071544107'));
  assert(snapshot.rows.some((row) => row.id === '1862698281071544106'));
});
await test('[Missed A] lifecycle-only current phase is running with remaining phases not started', async () => {
  const isolated = join(root, 'lifecycle-phase-state');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: '2026-09-12T12:30:00Z' };
  const storeDir = join(isolatedPaths.configDir, 'plugins', 'store');
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  writeFileSync(join(storeDir, 'wt-lifecycle-hooks_phase.json'), JSON.stringify({ 'card.1862698281071544105': { phase: 'verify', at: '2026-09-12T12:25:00Z' } }));
  const row = (await readSnapshot({ process: processCapability }, isolatedPaths)).rows.find((item) => item.id === '1862698281071544105');
  assert.equal(row.phaseStates.verify, 'running');
  assert.equal(Object.values(row.phaseStates).filter((state) => state === 'not started').length, 5);
});

await test('[DoD 1] each current activity signal admits a row and each stale counterpart does not', async () => {
  const isolated = join(root, 'activity-signals');
  const isolatedPaths = {
    configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'),
    suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: '2026-09-12T12:30:00Z', activeWindowMin: 10,
  };
  const storeDir = join(isolatedPaths.configDir, 'plugins', 'store');
  mkdirSync(storeDir, { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const fresh = new Date('2026-09-12T12:25:00Z');
  const stale = new Date('2026-09-12T12:00:00Z');
  const makeExternal = (name, id, mtime, pid = null) => {
    const lane = join(isolatedPaths.suiteRoot, 'worktrees', name, '.lane');
    mkdirSync(lane, { recursive: true });
    for (const [file, value] of [['brief.md', `# Brief: ${name} card ${id}\n`], ['run.log', 'working\n']]) {
      const target = join(lane, file); writeFileSync(target, value); utimesSync(target, mtime, mtime);
    }
    if (pid !== null) { const target = join(lane, 'pid'); writeFileSync(target, pid); utimesSync(target, mtime, mtime); }
  };
  makeExternal('fresh-file', '1862698281071544110', fresh);
  makeExternal('stale-file', '1862698281071544111', stale);
  makeExternal('live-pid', '1862698281071544112', stale, String(process.pid));
  makeExternal('dead-pid', '1862698281071544113', stale, '99999999');
  mkdirSync(join(isolatedPaths.procRoot, String(process.pid)), { recursive: true });
  const livePidWorktree = join(isolatedPaths.suiteRoot, 'worktrees', 'live-pid');
  writeFileSync(join(isolatedPaths.procRoot, String(process.pid), 'cmdline'), `wt-lane\0${livePidWorktree}\0`);
  symlinkSync(livePidWorktree, join(isolatedPaths.procRoot, String(process.pid), 'cwd'));
  for (const [name, id, updatedAt] of [
    ['fresh.json', '1862698281071544114', '2026-09-12T12:25:00Z'],
    ['stale.json', '1862698281071544115', '2026-09-12T12:00:00Z'],
  ]) writeFileSync(join(isolatedPaths.livenessDir, name), JSON.stringify({ scope: `card:${id}`, complete: false, updatedAt }));
  writeFileSync(join(isolatedPaths.livenessDir, 'complete.json'), JSON.stringify({ scope: 'card:1862698281071544109', status: 'complete', updatedAt: '2026-09-12T12:25:00Z' }));
  const freshStore = join(storeDir, 'wt-lifecycle-hooks_fresh.json');
  const staleStore = join(storeDir, 'wt-lifecycle-hooks_stale.json');
  writeFileSync(freshStore, JSON.stringify({ 'card.1862698281071544116': { phase: 'tdd' } }));
  writeFileSync(staleStore, JSON.stringify({ 'card.1862698281071544117': { phase: 'tdd' } }));
  utimesSync(freshStore, fresh, fresh); utimesSync(staleStore, stale, stale);

  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  for (const id of ['1862698281071544110', '1862698281071544112', '1862698281071544114', '1862698281071544116']) {
    assert(snapshot.rows.some((row) => row.id === id), `fresh signal ${id}`);
  }
  for (const id of ['1862698281071544109', '1862698281071544111', '1862698281071544113', '1862698281071544115', '1862698281071544117']) {
    assert(!snapshot.rows.some((row) => row.id === id), `stale signal ${id}`);
  }
});

await test('[DoD 1] non-Linux pid evidence is named unknown and cannot keep stale work alive', async () => {
  const isolated = join(root, 'non-linux-pid');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: '2026-09-12T12:30:00Z', platform: 'darwin' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'unknown-pid', '.lane');
  mkdirSync(lane, { recursive: true });
  for (const [name, value] of [['brief.md', '# Brief: unknown process card 1862698281071544119\n'], ['run.log', 'working\n'], ['pid', String(process.pid)]]) {
    const file = join(lane, name); writeFileSync(file, value); utimesSync(file, new Date('2026-09-12T12:00:00Z'), new Date('2026-09-12T12:00:00Z'));
  }
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert(!snapshot.rows.some((row) => row.id === '1862698281071544119'));
});
await test('[R2] an unrelated live pid cannot keep a stale lane alive', async () => {
  const isolated = join(root, 'unrelated-live-pid');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: '2026-09-12T12:30:00Z', platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const worktree = join(isolatedPaths.suiteRoot, 'worktrees', 'stale-unrelated');
  const lane = join(worktree, '.lane');
  mkdirSync(lane, { recursive: true });
  for (const [name, value] of [['brief.md', '# Brief: unrelated pid card 1862698281071544104\n'], ['run.log', 'working\n'], ['pid', String(process.pid)]]) {
    const file = join(lane, name); writeFileSync(file, value); utimesSync(file, new Date('2026-09-12T12:00:00Z'), new Date('2026-09-12T12:00:00Z'));
  }
  assert(!(await readSnapshot({ process: processCapability }, isolatedPaths)).rows.some((row) => row.id === '1862698281071544104'));
});

await test('[DoD 1] activeWindowMin controls worktree and liveness freshness', async () => {
  const isolated = join(root, 'configured-window');
  const base = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: '2026-09-12T12:30:00Z' };
  mkdirSync(join(base.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(base.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(base.livenessDir, { recursive: true });
  const lane = join(base.suiteRoot, 'worktrees', 'window', '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'brief.md'), '# Brief: configurable window card 1862698281071544118\n');
  writeFileSync(join(lane, 'run.log'), 'working\n');
  for (const file of ['brief.md', 'run.log']) utimesSync(join(lane, file), new Date('2026-09-12T12:15:00Z'), new Date('2026-09-12T12:15:00Z'));
  assert(!(await readSnapshot({ process: processCapability }, { ...base, activeWindowMin: 10 })).rows.some((row) => row.id === '1862698281071544118'));
  assert((await readSnapshot({ process: processCapability }, { ...base, activeWindowMin: 20 })).rows.some((row) => row.id === '1862698281071544118'));
});
await test('large gate logs and reports are read from bounded tails', async () => {
  writeFileSync(join(waveWorktree, '.lane', 'typecheck.log'), 'EXIT=9\n' + 'x'.repeat(140_000));
  writeFileSync(join(waveWorktree, '.lane', 'report.md'), 'review decision: accepted\n' + 'x'.repeat(300_000));
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  const row = snapshot.rows.find((item) => item.id === waveCardId);
  assert.equal(row.gates.typecheck, 'unknown');
  assert.equal(row.review.decision, 'unknown');
  writeFileSync(join(waveWorktree, '.lane', 'typecheck.log'), 'error\nEXIT=2\n');
  writeFileSync(join(waveWorktree, '.lane', 'report.md'), '## Verification\nreview decision: changes requested\n');
});
await test('missing per-card directories have unknown source labels', async () => {
  const bareWorktree = join(root, 'bare-worktree');
  mkdirSync(bareWorktree);
  writeFileSync(join(livenessDir, 'bare.json'), JSON.stringify({
    scope: 'card:1862698281071544195', complete: false, worktree: bareWorktree, updatedAt: paths.now,
  }));
  const snapshot = await readSnapshot({ process: processCapability }, { ...paths, extraRoots: [bareWorktree] });
  const sources = snapshot.rows.find((row) => row.id === '1862698281071544195').sources;
  assert.equal(sources.gateLogs, 'unknown');
  assert.equal(sources.reviews, 'unknown');
  assert.equal(sources.usage, 'unknown');
  rmSync(join(livenessDir, 'bare.json'));
});
await test('[A-3] SDK pilots nest a lane only with independently live process evidence', async () => {
  const isolated = join(root, 'external-pids');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const cases = [
    ['live', '1862698281071544140', String(process.pid)],
    ['dead', '1862698281071544141', '99999999'],
    ['absent', '1862698281071544142', null],
  ];
  for (const [name, id, pid] of cases) {
    const lane = join(isolatedPaths.suiteRoot, 'worktrees', name, '.lane');
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId: id, route: 'FULL' }));
    writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=tdd\n');
    if (pid) writeFileSync(join(lane, 'pid'), pid);
  }
  mkdirSync(join(isolatedPaths.procRoot, String(process.pid)), { recursive: true });
  const liveWorktree = join(isolatedPaths.suiteRoot, 'worktrees', 'live');
  writeFileSync(join(isolatedPaths.procRoot, String(process.pid), 'cmdline'), `wt-pilot-runner\0${liveWorktree}\0`);
  symlinkSync(liveWorktree, join(isolatedPaths.procRoot, String(process.pid), 'cwd'));
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.equal(snapshot.rows.find((row) => row.id === cases[0][1]).lanes.length, process.platform === 'linux' ? 1 : 0);
  assert.equal(snapshot.rows.find((row) => row.id === cases[1][1]).lanes.length, 0);
  assert.equal(snapshot.rows.find((row) => row.id === cases[2][1]).lanes.length, 0);
  if (process.platform !== 'linux') assert.equal(snapshot.rows.find((row) => row.id === cases[0][1]).who.includes('unknown'), true);
});
await test('[A-4] duplicate card receipts attach only by the running worktree wave identity', async () => {
  const isolated = join(root, 'duplicate-waves');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const id = '1862698281071544143';
  for (const wave of ['running', 'old']) {
    mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees', `wave-${wave}`, 'cards', id), { recursive: true });
    writeFileSync(join(isolatedPaths.suiteRoot, 'worktrees', `wave-${wave}`, 'cards', id, 'card.md'), `# ${wave} title\n`);
  }
  const pilot = join(isolatedPaths.suiteRoot, 'worktrees', `card-${id}-wave-running`, '.lane');
  mkdirSync(pilot, { recursive: true });
  writeFileSync(join(pilot, 'route.json'), JSON.stringify({ cardId: id, route: 'FULL' }));
  writeFileSync(join(pilot, 'runner-stdout.log'), 'lifecycle: accepted phase=plan\n');
  const row = (await readSnapshot({ process: processCapability }, isolatedPaths)).rows.find((item) => item.id === id);
  assert.equal(row.waveId, 'running');
  assert.equal(row.title, 'running title');
});
await test('[A-5] linkBase uses a suite-relative URL and outside liveness content is refused', async () => {
  const linked = await readSnapshot({ process: processCapability }, { ...paths, linkBase: 'http://localhost:9000/files' });
  assert.equal(linked.rows.find((row) => row.id === waveCardId).inspectors.plan.href, `http://localhost:9000/files/worktrees/card-${waveCardId}-wave-${waveId}/.lane/plan.md.html`);
  const outside = join(root, 'outside-artifact');
  mkdirSync(join(outside, '.lane'), { recursive: true });
  writeFileSync(join(outside, '.lane', 'brief.md'), '# Brief: card 1862698281071544144: Outside canary\n');
  writeFileSync(join(outside, '.lane', 'run.log'), 'working\n');
  writeFileSync(join(outside, '.lane', 'review-report.md'), 'review decision: changes requested\nTOP_SECRET_REPORT_CANARY\n');
  writeFileSync(join(outside, 'usage.json'), JSON.stringify({ input_tokens: 987654321 }));
  writeFileSync(join(livenessDir, 'outside.json'), JSON.stringify({ scope: 'card:1862698281071544144', complete: false, worktree: outside, updatedAt: paths.now }));
  const outsideSnapshot = await readSnapshot({ process: processCapability }, { ...paths, linkBase: 'http://localhost:9000/files' });
  const serialized = JSON.stringify(outsideSnapshot);
  assert(!outsideSnapshot.rows.some((row) => row.id === '1862698281071544144'));
  assert(!serialized.includes('TOP_SECRET_REPORT_CANARY'));
  assert(!serialized.includes('987654321'));
  assert.equal(outsideSnapshot.discovery, 'partial');
  assert.deepEqual(outsideSnapshot.pathRefusals, ['liveness live actor path was outside allowed roots']);
  assert(!serialized.includes(outside));
  rmSync(join(livenessDir, 'outside.json'));
});
await test('[allowed roots] declared external scratch review directories remain readable', async () => {
  const isolated = join(root, 'declared-scratch');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const scratchRoot = join(isolated, 'scratch');
  const scratch = join(scratchRoot, 'review-one');
  mkdirSync(join(scratch, '.lane'), { recursive: true });
  writeFileSync(join(scratch, '.lane', 'brief.md'), '# Brief: review card 1862698281071544144\n');
  writeFileSync(join(scratch, '.lane', 'run.log'), 'working\n');
  writeFileSync(join(scratch, '.lane', 'review-report.md'), 'review decision: changes requested\nDECLARED_REVIEW_CANARY\n');
  writeFileSync(join(scratch, 'usage.json'), JSON.stringify({ input_tokens: 424242 }));
  writeFileSync(join(isolatedPaths.livenessDir, 'scratch.json'), JSON.stringify({ scope: 'card:1862698281071544144', complete: false, worktree: scratch, updatedAt: paths.now }));
  const snapshot = await readSnapshot({ process: processCapability }, { ...isolatedPaths, extraRoots: [scratchRoot] });
  const serialized = JSON.stringify(snapshot);
  assert(snapshot.rows.some((row) => row.id === '1862698281071544144'));
  assert(serialized.includes('DECLARED_REVIEW_CANARY'));
  assert(serialized.includes('424242'));
  assert.equal(snapshot.discovery, 'available');
});
await test('[allowed roots] a worktree equal to its declared root is admitted', async () => {
  const isolated = join(root, 'declared-root-equality');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const declaredRoot = join(isolated, 'exact-root');
  mkdirSync(join(declaredRoot, '.lane'), { recursive: true });
  writeFileSync(join(declaredRoot, '.lane', 'brief.md'), '# Brief: review card 1862698281071544101\n');
  writeFileSync(join(declaredRoot, '.lane', 'run.log'), 'working\n');
  writeFileSync(join(declaredRoot, '.lane', 'review-report.md'), 'review decision: changes requested\nEQUAL_ROOT_CANARY\n');
  writeFileSync(join(isolatedPaths.livenessDir, 'exact.json'), JSON.stringify({ scope: 'card:1862698281071544101', complete: false, worktree: declaredRoot, updatedAt: paths.now }));
  const snapshot = await readSnapshot({ process: processCapability }, { ...isolatedPaths, extraRoots: [declaredRoot] });
  assert(JSON.stringify(snapshot).includes('EQUAL_ROOT_CANARY'));
  assert.equal(snapshot.discovery, 'available');
});
await test('[allowed roots] a declared root that is itself a symlink is admitted', async () => {
  const isolated = join(root, 'declared-symlink-root');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const target = join(isolated, 'target');
  const declaredRoot = join(isolated, 'root-link');
  mkdirSync(join(target, '.lane'), { recursive: true });
  writeFileSync(join(target, '.lane', 'brief.md'), '# Brief: review card 1862698281071544102\n');
  writeFileSync(join(target, '.lane', 'run.log'), 'working\n');
  writeFileSync(join(target, '.lane', 'review-report.md'), 'review decision: changes requested\nSYMLINK_ROOT_CANARY\n');
  symlinkSync(target, declaredRoot);
  writeFileSync(join(isolatedPaths.livenessDir, 'symlink.json'), JSON.stringify({ scope: 'card:1862698281071544102', complete: false, worktree: declaredRoot, updatedAt: paths.now }));
  const snapshot = await readSnapshot({ process: processCapability }, { ...isolatedPaths, extraRoots: [declaredRoot] });
  assert(JSON.stringify(snapshot).includes('SYMLINK_ROOT_CANARY'));
  assert.equal(snapshot.discovery, 'available');
});
await test('[allowed roots] a nested declared symlink root is admitted by its canonical target', async () => {
  const isolated = join(root, 'nested-declared-symlink-root');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const worktreeRoot = join(isolatedPaths.suiteRoot, 'worktrees');
  mkdirSync(worktreeRoot, { recursive: true });
  const target = join(isolated, 'target');
  const declaredRoot = join(worktreeRoot, 'root-link');
  mkdirSync(join(target, '.lane'), { recursive: true });
  writeFileSync(join(target, '.lane', 'brief.md'), '# Brief: review card 1862698281071544103: NESTED_SYMLINK_ROOT_CANARY\n');
  writeFileSync(join(target, '.lane', 'run.log'), 'working\n');
  writeFileSync(join(target, '.lane', 'review-report.md'), 'review decision: changes requested\nNESTED_SYMLINK_ROOT_CANARY\n');
  symlinkSync(target, declaredRoot);
  writeFileSync(join(isolatedPaths.livenessDir, 'nested-symlink.json'), JSON.stringify({ scope: 'card:1862698281071544103', complete: false, worktree: declaredRoot, updatedAt: paths.now }));
  const snapshot = await readSnapshot({ process: processCapability }, { ...isolatedPaths, extraRoots: [declaredRoot] });
  assert(JSON.stringify(snapshot).includes('NESTED_SYMLINK_ROOT_CANARY'));
  assert.equal(snapshot.rows.find((row) => row.id === '1862698281071544103')?.worktree, target);
  assert.equal(snapshot.discovery, 'available');
});
await test('[allowed roots] symlink escapes are refused before lane content is read', async () => {
  const isolated = join(root, 'read-symlink-escape');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const worktreeRoot = join(isolatedPaths.suiteRoot, 'worktrees');
  mkdirSync(worktreeRoot, { recursive: true });
  const escaped = join(isolated, 'escaped');
  mkdirSync(join(escaped, '.lane'), { recursive: true });
  writeFileSync(join(escaped, '.lane', 'brief.md'), '# Brief: card 1862698281071544145: Symlink canary\n');
  writeFileSync(join(escaped, '.lane', 'run.log'), 'working\n');
  writeFileSync(join(escaped, '.lane', 'review-report.md'), 'SYMLINK_REPORT_CANARY\n');
  const linkedWorktree = join(worktreeRoot, 'linked');
  symlinkSync(escaped, linkedWorktree);
  writeFileSync(join(isolatedPaths.livenessDir, 'linked.json'), JSON.stringify({ scope: 'card:1862698281071544145', complete: false, worktree: linkedWorktree, updatedAt: paths.now }));
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const serialized = JSON.stringify(snapshot);
  assert(!snapshot.rows.some((row) => row.id === '1862698281071544145'));
  assert(!serialized.includes('SYMLINK_REPORT_CANARY'));
  assert.deepEqual(snapshot.pathRefusals, ['liveness live actor symlink escaped an allowed root']);
  assert(!serialized.includes(linkedWorktree));

  const nested = join(worktreeRoot, 'nested-link');
  const escapedLane = join(isolated, 'escaped-lane');
  mkdirSync(nested, { recursive: true });
  mkdirSync(escapedLane, { recursive: true });
  writeFileSync(join(escapedLane, 'brief.md'), '# Brief: card 1862698281071544147: Nested symlink\nNESTED_SYMLINK_CANARY\n');
  writeFileSync(join(escapedLane, 'run.log'), 'working\n');
  symlinkSync(escapedLane, join(nested, '.lane'));
  writeFileSync(join(isolatedPaths.livenessDir, 'nested.json'), JSON.stringify({ scope: 'card:1862698281071544147', complete: false, worktree: nested, updatedAt: paths.now }));
  const nestedSnapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert(!JSON.stringify(nestedSnapshot).includes('NESTED_SYMLINK_CANARY'));
});
await test('[allowed roots] process --dir outside configured roots cannot create an actor', async () => {
  const isolated = join(root, 'outside-process');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const outside = join(isolated, 'process-secret');
  mkdirSync(join(outside, '.lane'), { recursive: true });
  writeFileSync(join(outside, '.lane', 'brief.md'), '# Brief: review card 1862698281071544146\nPROCESS_PATH_CANARY\n');
  writeFileSync(join(outside, '.lane', 'run.log'), 'working\n');
  const pid = '730';
  mkdirSync(join(isolatedPaths.procRoot, pid), { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, pid, 'status'), 'Name:\topencode\nPPid:\t1\n');
  writeFileSync(join(isolatedPaths.procRoot, pid, 'cmdline'), ['opencode', 'run', '--dir', outside].join('\0') + '\0');
  const cwdPid = '731';
  mkdirSync(join(isolatedPaths.procRoot, cwdPid), { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, cwdPid, 'status'), 'Name:\topencode\nPPid:\t1\n');
  writeFileSync(join(isolatedPaths.procRoot, cwdPid, 'cmdline'), ['opencode', 'run'].join('\0') + '\0');
  symlinkSync(outside, join(isolatedPaths.procRoot, cwdPid, 'cwd'));
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const serialized = JSON.stringify(snapshot);
  assert(!serialized.includes('1862698281071544146'));
  assert(!serialized.includes('PROCESS_PATH_CANARY'));
  assert.deepEqual(snapshot.pathRefusals, []);
  assert.equal(snapshot.discovery, 'available');
  assert(!serialized.includes(outside));
  rmSync(join(isolatedPaths.procRoot, pid), { recursive: true, force: true });
  const cwdSnapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.deepEqual(cwdSnapshot.pathRefusals, []);
  assert.equal(cwdSnapshot.discovery, 'available');
  assert(!JSON.stringify(cwdSnapshot).includes(outside));

  rmSync(join(isolatedPaths.procRoot, cwdPid), { recursive: true, force: true });
  const allowed = join(isolatedPaths.suiteRoot, 'worktrees', 'allowed-process');
  mkdirSync(join(allowed, '.lane'), { recursive: true });
  const briefPid = '732';
  mkdirSync(join(isolatedPaths.procRoot, briefPid), { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, briefPid, 'status'), 'Name:\topencode\nPPid:\t1\n');
  writeFileSync(join(isolatedPaths.procRoot, briefPid, 'cmdline'), ['opencode', 'run', '--dir', allowed, '--brief', join(outside, '.lane', 'brief.md')].join('\0') + '\0');
  const briefSnapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert(!JSON.stringify(briefSnapshot).includes('PROCESS_PATH_CANARY'));
  assert(!JSON.stringify(briefSnapshot).includes('1862698281071544146'));
});
await test('[allowed roots] lifecycle and spawn worktrees are validated before actor reads', async () => {
  const isolated = join(root, 'outside-records');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  const store = join(isolatedPaths.configDir, 'plugins', 'store');
  const registry = join(isolatedPaths.configDir, 'plugins', 'data', 'registry');
  mkdirSync(store, { recursive: true });
  mkdirSync(registry, { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const lifecycleWorktree = join(isolated, 'lifecycle-secret');
  const spawnWorktree = join(isolated, 'spawn-secret');
  for (const [worktree, marker] of [[lifecycleWorktree, 'LIFECYCLE_PATH_CANARY'], [spawnWorktree, 'SPAWN_PATH_CANARY']]) {
    mkdirSync(join(worktree, '.lane'), { recursive: true });
    writeFileSync(join(worktree, '.lane', 'report.md'), marker + '\n');
  }
  writeFileSync(join(store, 'wt-lifecycle-hooks_roots.json'), JSON.stringify({
    'card.1862698281071544148': { phase: 'tdd', at: paths.now, worktree: lifecycleWorktree },
  }));
  writeFileSync(join(registry, 'session.jsonl'), JSON.stringify({ t: 'spawn', child: 'outside-worker-id', name: 'outside-worker', purpose: 'card 1862698281071544149', worktree: spawnWorktree }) + '\n');
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const serialized = JSON.stringify(snapshot);
  assert(!serialized.includes('1862698281071544148'));
  assert(!serialized.includes('1862698281071544149'));
  assert(!serialized.includes('LIFECYCLE_PATH_CANARY'));
  assert(!serialized.includes('SPAWN_PATH_CANARY'));
  assert.deepEqual(snapshot.pathRefusals, [
    'lifecycle live actor path was outside allowed roots',
    'spawn registry live actor path was outside allowed roots',
  ]);
});
await test('[E-1] a symlinked worktree ancestor escaping suiteRoot cannot receive HTML', async () => {
  const isolated = join(root, 'symlink-escape');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now, linkBase: 'http://localhost:9000/files' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const escaped = join(isolated, 'escaped-worktree');
  mkdirSync(join(escaped, '.lane'), { recursive: true });
  writeFileSync(join(escaped, '.lane', 'route.json'), JSON.stringify({ cardId: '1862698281071544145', route: 'FULL' }));
  writeFileSync(join(escaped, '.lane', 'runner-stdout.log'), 'lifecycle: accepted phase=plan\n');
  writeFileSync(join(escaped, '.lane', 'plan.md'), '# Must not write\n');
  symlinkSync(escaped, join(isolatedPaths.suiteRoot, 'worktrees', 'escaped-link'));
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert(!snapshot.rows.some((item) => item.id === '1862698281071544145'));
  assert(!JSON.stringify(snapshot).includes('Must not write'));
  assert.equal(statSync(join(escaped, '.lane', 'plan.md')).isFile(), true);
  assert.throws(() => statSync(join(escaped, '.lane', 'plan.md.html')));
});
await test('[write failure] an unwritable lane degrades its artifact to Text without poisoning the snapshot', async () => {
  const isolated = join(root, 'write-failure');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now, linkBase: 'http://localhost:9000/files' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'unwritable', '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId: '1862698281071544146', route: 'FULL' }));
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=plan\n');
  writeFileSync(join(lane, 'plan.md'), '# Still readable\n');
  chmodSync(lane, 0o500);
  try {
    const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
    assert.equal(snapshot.discovery, 'available');
    assert.equal(snapshot.rows.find((row) => row.id === '1862698281071544146').inspectors.plan.href, null);
  } finally { chmodSync(lane, 0o700); }
});
await test('[stale HTML] changed source metadata regenerates even when the replacement mtime is older', async () => {
  const isolated = join(root, 'stale-html');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now, linkBase: 'http://localhost:9000/files' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'older-source', '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId: '1862698281071544147', route: 'FULL' }));
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=plan\n');
  const source = join(lane, 'plan.md');
  writeFileSync(source, '# First value\n');
  await readSnapshot({ process: processCapability }, isolatedPaths);
  writeFileSync(source, '# Older value\n');
  utimesSync(source, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
  await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.match(readFileSync(source + '.html', 'utf8'), /Older value/);
});
await test('[E-2] directory scans stop at the configured cap and record the capped path', async () => {
  const isolated = join(root, 'scan-cap');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now, scanEntryCap: 3 };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  for (let index = 0; index < 5; index += 1) writeFileSync(join(isolatedPaths.livenessDir, `${index}.json`), JSON.stringify({ scope: `card:${1862698281071544120n + BigInt(index)}`, complete: false, updatedAt: paths.now }));
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.equal(snapshot.rows.length, 3);
  assert(snapshot.cappedScans.includes(isolatedPaths.livenessDir));
  assert.equal(snapshot.discovery, 'partial');
  cappedDiscoverySnapshot = snapshot;
});

await test('[collector budget] detailed worktree reads stop at their own cap and name the partial scan', async () => {
  const isolated = join(root, 'worktree-detail-cap');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now, worktreeDetailCap: 3 };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  for (let index = 0; index < 5; index += 1) {
    const lane = join(isolatedPaths.suiteRoot, 'worktrees', `lane-${index}`, '.lane');
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, 'brief.md'), `# Brief: cap fixture card ${1862698281071544120n + BigInt(index)}\n`);
    writeFileSync(join(lane, 'run.log'), 'working\n');
  }
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.equal(snapshot.discovery, 'partial');
  assert.equal(snapshot.rows.length, 3);
  assert.deepEqual(snapshot.scanLimits, [`worktree detail cap reached: 3 of 5 at ${join(isolatedPaths.suiteRoot, 'worktrees')}`]);
  assert.equal(snapshot.collectors.work.availability.reason, snapshot.scanLimits[0]);
});

await test('[collector budget] process timeout and exit failure retain distinct non-blank reasons', async () => {
  let timeoutInit;
  const timedOut = await readSnapshot({ process: { run: async (_argv, init) => {
    timeoutInit = init;
    const error = new Error('process timed out after 8000 ms');
    error.code = 'ETIMEDOUT';
    throw error;
  } } }, paths);
  assert.deepEqual(timeoutInit, { timeoutMs: 8000 });
  assert.equal(timedOut.collectors.work.availability.reason, 'collector timed out after 8 s');
  const failed = await readSnapshot({ process: { run: async () => ({ exitCode: 17, stdout: '', stderr: 'first stderr line\nsecond line\n' }) } }, paths);
  assert.equal(failed.collectors.work.availability.reason, 'collector failed (exit code 17; first stderr line)');
});

await test('[Round 7 scan cap] exact limits are complete and normal retained reports fit the bounded walk', async () => {
  const isolated = join(root, 'normal-report-volume');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const worktree = join(isolatedPaths.suiteRoot, 'worktrees', 'active');
  mkdirSync(join(worktree, '.lane'), { recursive: true });
  writeFileSync(join(worktree, '.lane', 'brief.md'), '# Brief: card 1862698281071544125: Report scan\n');
  writeFileSync(join(worktree, '.lane', 'run.log'), 'working\n');
  const reports = join(isolatedPaths.suiteRoot, 'reports');
  mkdirSync(reports, { recursive: true });
  for (let index = 0; index < 501; index += 1) writeFileSync(join(reports, `${index}.md`), 'historical report\n');
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.equal(snapshot.discovery, 'available');
  assert.deepEqual(snapshot.cappedScans, []);

  const exact = await readSnapshot({ process: processCapability }, { ...isolatedPaths, scanEntryCap: 501 });
  assert.equal(exact.discovery, 'available');
  assert.deepEqual(exact.cappedScans, []);
});

await test('[WIR5-06] unreadable and capped proc scans report partial process discovery', async () => {
  const isolated = join(root, 'partial-proc');
  const base = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'missing-proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(base.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(base.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(base.livenessDir, { recursive: true }); mkdirSync(join(base.suiteRoot, 'worktrees'), { recursive: true });
  const unreadable = await readSnapshot({ process: processCapability }, base);
  assert.equal(unreadable.processDiscovery, 'partial'); assert.equal(unreadable.processPartialReason, 'unreadable');
  const cappedRoot = join(isolated, 'capped-proc'); mkdirSync(cappedRoot, { recursive: true });
  for (const pid of [100, 200, 300]) mkdirSync(join(cappedRoot, String(pid)));
  const capped = await readSnapshot({ process: processCapability }, { ...base, procRoot: cappedRoot, scanEntryCap: 2 });
  assert.equal(capped.processDiscovery, 'partial'); assert.equal(capped.processPartialReason, 'capped');
});

await test('[WIR5-07] a process that exits mid-scan is not a read failure; a record that exists and cannot be read is one', async () => {
  // Field case 2026-09-15 (card 1864810463074714727): the pane read `process list partial (unreadable process records)`
  // on a quiet machine. Measured on the real host: 1 collector run in 10 met a process that exited between the
  // /proc listing and its record reads. That race is complete discovery of what exists, never a degraded scan.
  const isolated = join(root, 'vanished-proc');
  const procFixture = join(isolated, 'proc'); mkdirSync(procFixture, { recursive: true });
  const base = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: procFixture, now: paths.now, platform: 'linux' };
  mkdirSync(join(base.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(base.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(base.livenessDir, { recursive: true }); mkdirSync(join(base.suiteRoot, 'worktrees'), { recursive: true });
  writeFileSync(join(procFixture, 'uptime'), '20000.00 1000.00\n');
  // 4242 is listed, then gone before its records are read: a dangling entry stands in for the race.
  // Windows refuses symlinks without a privilege; that half of the lock is then skipped, and says so.
  let dangling = true;
  try { symlinkSync(join(isolated, 'no-such-process'), join(procFixture, '4242')); } catch (error) { if (error?.code !== 'EPERM') throw error; dangling = false; console.log('  (symlink refused on this host; the vanished half of WIR5-07 is not exercised here)'); }
  if (dangling) {
    // Only vanished entries: that is not a race, it is the source going away under the scan → unreadable.
    const sourceLost = await readSnapshot({ process: processCapability }, base);
    assert.equal(sourceLost.processDiscovery, 'partial'); assert.equal(sourceLost.processPartialReason, 'unreadable'); assert.equal(sourceLost.processVanished, 1);
  }
  // 4141 is a live, readable process: with a survivor in the listing, a vanished entry is the ordinary race.
  mkdirSync(join(procFixture, '4141'), { recursive: true });
  writeFileSync(join(procFixture, '4141', 'cmdline'), 'sleep\x00600\x00');
  writeFileSync(join(procFixture, '4141', 'status'), 'Name:\tsleep\nPPid:\t1\n');
  const survivor = await readSnapshot({ process: processCapability }, base);
  assert.equal(survivor.processDiscovery, 'available'); assert.equal(survivor.processPartialReason, null); assert.equal(survivor.processVanished, dangling ? 1 : 0);
  // 4343 still exists and its cmdline cannot be read (a directory where a file is expected): that IS a failure.
  mkdirSync(join(procFixture, '4343', 'cmdline'), { recursive: true });
  const unreadable = await readSnapshot({ process: processCapability }, base);
  assert.equal(unreadable.processDiscovery, 'partial'); assert.equal(unreadable.processPartialReason, 'unreadable process records'); assert.equal(unreadable.processVanished, dangling ? 1 : 0);
});

await test('[Step 5 DoD 1] proc ancestry emits separate Session and linked Card levels', async () => {
  const isolated = join(root, 'process-hierarchy');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', plankaBaseUrl: 'https://boards.example.test' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const card = '1862698281071544130';
  const makeProcess = (pid, ppid, args) => {
    mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true });
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), `Name:\tfixture\nPPid:\t${ppid}\n`);
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), args.join('\0') + '\0');
  };
  for (const sessionPid of [100, 200]) makeProcess(sessionPid, 1, ['claude', '--model', 'haiku']);
  for (const [sessionPid, pid, name] of [[100, 110, 'lane-a'], [200, 210, 'lane-b']]) {
    const dir = join(isolatedPaths.suiteRoot, 'worktrees', name);
    mkdirSync(join(dir, '.lane'), { recursive: true });
    writeFileSync(join(dir, '.lane', 'brief.md'), `# Brief: card ${card}: ${name}\n`);
    writeFileSync(join(dir, '.lane', 'run.log'), '→ Read hooks.js\n');
    writeFileSync(join(dir, '.lane', 'pid'), String(pid));
    makeProcess(pid, sessionPid, ['opencode', 'run', '--dir', dir, '--model', 'openai/gpt-5.6-sol']);
  }
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.equal(snapshot.sessions.length, 2);
  assert(snapshot.sessions.every((session) => session.launcher.startsWith('Claude pid ')));
  assert(snapshot.sessions.every((session) => session.cards[0].id === card));
  assert(snapshot.sessions.every((session) => session.cards[0].cardUrl === `https://boards.example.test/cards/${card}`));
});

await test('[WIR5-02 changed][Step 5 DoD 2] lane actors prefer process age and label pid-file fallback', async () => {
  const isolated = join(root, 'lane-now');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: '2026-09-12T12:30:00Z', platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true }); mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const dir = join(isolatedPaths.suiteRoot, 'worktrees', 'active'); const lane = join(dir, '.lane');
  mkdirSync(lane, { recursive: true }); writeFileSync(join(lane, 'brief.md'), '# Brief: card 1862698281071544131: Active lane\n'); writeFileSync(join(lane, 'run.log'), 'old line\n$ pnpm test\nnoise\n'); writeFileSync(join(lane, 'pid'), '310'); utimesSync(join(lane, 'pid'), new Date('2026-09-12T12:18:00Z'), new Date('2026-09-12T12:18:00Z'));
  mkdirSync(isolatedPaths.procRoot, { recursive: true }); writeFileSync(join(isolatedPaths.procRoot, 'uptime'), '20000.00 1000.00\n');
  for (const [pid, ppid, args] of [[300, 1, ['claude']], [310, 300, ['opencode', 'run', '--dir', dir, '--model', 'gpt-fixture']]]) { mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true }); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), `PPid:\t${ppid}\n`); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), args.join('\0') + '\0'); }
  writeFileSync(join(isolatedPaths.procRoot, '310', 'stat'), `310 (fixture) S 300 ${Array(17).fill('0').join(' ')} 1880000\n`);
  const actor = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions[0].cards[0].actors[0];
  assert.equal(actor.activity, '$ pnpm test'); assert.equal(actor.elapsed, '20 min'); assert.equal(actor.model, 'gpt-fixture');
  rmSync(join(isolatedPaths.procRoot, '310', 'stat'));
  const fallback = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions[0].cards[0].actors[0];
  assert.equal(fallback.elapsed, '~12 min');
});

await test('[WIR5-01 changed][Step 5 DoD 3] review tasks attach only through actor ancestry', async () => {
  const isolated = join(root, 'scratch-actors');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true }); mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const scratch = join(isolated, 'scratch-review'); mkdirSync(join(scratch, '.lane'), { recursive: true }); writeFileSync(join(scratch, '.lane', 'brief.md'), '# Security review for card 1862698281071544132\n'); writeFileSync(join(scratch, '.lane', 'run.log'), 'Write .lane/report.md\n');
  const processes = [[400, 1, ['claude']], [410, 400, ['opencode', 'run', '--dir', scratch, '--model', 'gpt-review']], [420, 410, ['node', '/tools/codex-companion.mjs', 'task', 'Refutation for card 1862698281071544132']], [430, 410, ['node', '/tools/codex-companion.mjs', 'task', 'Consult Astra about locking for card 1862698281071544132']]];
  for (const [pid, ppid, args] of processes) { mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true }); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), `PPid:\t${ppid}\n`); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), args.join('\0') + '\0'); }
  const card = (await readSnapshot({ process: processCapability }, { ...isolatedPaths, extraRoots: [scratch] })).sessions[0].cards[0];
  const actors = card.actors.flatMap((actor) => [actor, ...(actor.children || [])]);
  assert.deepEqual(actors.map((actor) => actor.label).sort(), ['Astra consultation', 'Refutation', 'Review lane']);
  assert(card.actors.find((actor) => actor.label === 'Review lane').role.includes('Security review'));
  assert.deepEqual(card.actors.find((actor) => actor.label === 'Review lane').children.map((actor) => actor.label).sort(), ['Astra consultation', 'Refutation']);
});

await test('[WIR5-01] Astra task 130 follows parent lane 120, never preferred review 110 or card id alone', async () => {
  const isolated = join(root, 'ancestry-ownership');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const cardId = '1862698281071544165';
  const review = join(isolated, 'review'); const lane = join(isolated, 'lane');
  for (const [dir, heading] of [[review, 'Security review'], [lane, 'Implementation lane']]) { mkdirSync(join(dir, '.lane'), { recursive: true }); writeFileSync(join(dir, '.lane', 'brief.md'), `# ${heading} for card ${cardId}\n`); writeFileSync(join(dir, '.lane', 'run.log'), 'working\n'); }
  const fixtures = [[100, 1, ['claude']], [110, 100, ['opencode', 'run', '--dir', review]], [120, 100, ['opencode', 'run', '--dir', lane]], [130, 120, ['node', '/tools/codex-companion.mjs', 'task', `Consult Astra for card ${cardId}`]], [140, 100, ['node', '/tools/codex-companion.mjs', 'task', `Refutation for card ${cardId}`]]];
  for (const [pid, ppid, args] of fixtures) { mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true }); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), `PPid:\t${ppid}\n`); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), args.join('\0') + '\0'); }
  const card = (await readSnapshot({ process: processCapability }, { ...isolatedPaths, extraRoots: [review, lane] })).sessions[0].cards[0];
  const reviewActor = card.actors.find((actor) => actor.processPid === 110);
  const laneActor = card.actors.find((actor) => actor.processPid === 120);
  assert.deepEqual((reviewActor.children || []).map((actor) => actor.processPid), []);
  assert.deepEqual((laneActor.children || []).map((actor) => actor.processPid), [130]);
  assert(card.actors.some((actor) => actor.processPid === 140 && actor.label === 'Refutation'));
});

await test('[WIR5-01 missed nesting] a card-matched lane uses its own process session, not its pilot session', async () => {
  const isolated = join(root, 'nested-lane-session');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const cardId = '1862698281071544166';
  const pilot = join(isolatedPaths.suiteRoot, 'worktrees', 'pilot'); const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'other-session-lane');
  mkdirSync(join(pilot, '.lane'), { recursive: true }); writeFileSync(join(pilot, '.lane', 'route.json'), JSON.stringify({ cardId })); writeFileSync(join(pilot, '.lane', 'runner-stdout.log'), 'lifecycle: accepted phase=tdd\n');
  mkdirSync(join(lane, '.lane'), { recursive: true }); writeFileSync(join(lane, '.lane', 'brief.md'), `# Brief: card ${cardId}: Other session lane\n`); writeFileSync(join(lane, '.lane', 'run.log'), 'working\n');
  const fixtures = [[100, 1, ['claude']], [110, 100, ['opencode', 'run', '--dir', pilot]], [200, 1, ['claude']], [210, 200, ['opencode', 'run', '--dir', lane]]];
  for (const [pid, ppid, args] of fixtures) { mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true }); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), `PPid:\t${ppid}\n`); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), args.join('\0') + '\0'); }
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.equal(snapshot.sessions.find((session) => session.pid === 100).cards[0].actors.some((actor) => actor.processPid === 210), false);
  assert.equal(snapshot.sessions.find((session) => session.pid === 200).cards[0].actors.some((actor) => actor.processPid === 210), true);
});

await test('[changed Arbiter service split][Step 5 DoD 4] idle helpers are counted once with their oldest age and details', async () => {
  const isolated = join(root, 'idle-helpers');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', processEnv: { PATH: '/missing' } };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true }); mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  for (const [pid, ppid, args] of [[500, 1, ['codex', 'app-server']], [510, 1, ['python3', '-m', 'http.server', '8765']], [520, 1, ['node', '/tools/codex-companion.mjs', 'task', 'active consultation']], [521, 520, ['codex', 'app-server']]]) { mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true }); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), `PPid:\t${ppid}\n`); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), args.join('\0') + '\0'); }
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.equal(snapshot.helpers.count, 1); assert.equal(snapshot.helpers.items.length, 1); assert.equal(snapshot.services.count, 1); assert.match(snapshot.helpers.oldest, /unknown/);
});

await test('[Arbiter fix 1 proc age] Linux helper ages use fixture stat starttime and uptime', async () => {
  const isolated = join(root, 'proc-ages');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', clockTicks: 100, processEnv: { PATH: '/missing' } };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true }); mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true }); mkdirSync(isolatedPaths.procRoot, { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, 'uptime'), '20000.00 1000.00\n');
  for (const [pid, startTicks] of [[500, 1880000], [501, 860000]]) {
    mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true });
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), 'Name:\tcodex\nPPid:\t1\n');
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), 'codex\0app-server\0');
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'stat'), `${pid} (codex fixture) S 1 ${Array(17).fill('0').join(' ')} ${startTicks}\n`);
  }
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.deepEqual(snapshot.helpers.items.map((item) => item.age).sort(), ['20 min', '3 h 10 min']);
  assert.equal(snapshot.helpers.oldest, '3 h 10 min');
  const otherPlatform = await readSnapshot({ process: processCapability }, { ...isolatedPaths, platform: 'darwin' });
  assert.equal(otherPlatform.helpers.count, 0);
});

await test('[WIR5-03 changed][Arbiter fix 2 services] executable identities classify services without argv substring decoys', async () => {
  const isolated = join(root, 'service-classification');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', clockTicks: 100, processEnv: { PATH: '/missing' } };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true }); mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true }); mkdirSync(isolatedPaths.procRoot, { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, 'uptime'), '20000.00 1000.00\n');
  const brokerRoot = join(isolated, 'atr-clean-test'); mkdirSync(join(brokerRoot, 'bin'), { recursive: true }); writeFileSync(join(brokerRoot, 'package.json'), JSON.stringify({ name: 'atrium' })); writeFileSync(join(brokerRoot, 'bin', 'broker.js'), '');
  const fixtures = [[600, 1, ['codex', 'app-server']], [610, 1, ['bun', join(brokerRoot, 'bin', 'broker.js')]], [620, 1, ['python3', '-m', 'http.server', '8765']], [630, 1, ['node', '/plugin/bin/wt-artifact-server.mjs', 'serve']], [640, 1, ['node', '/tools/codex-companion.mjs', 'task', 'active']], [641, 640, ['codex', 'app-server']], [650, 1, ['bash', '-c', 'echo atrium broker']], [660, 1, ['bash', '-c', 'python3 -m http.server']], [670, 1, ['bash', '-c', 'codex app-server']], [680, 1, ['bash', '-c', 'wt-artifact-server.mjs serve']]];
  for (const [pid, ppid, args] of fixtures) { mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true }); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), `PPid:\t${ppid}\n`); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), args.join('\0') + '\0'); writeFileSync(join(isolatedPaths.procRoot, String(pid), 'stat'), `${pid} (fixture) S ${ppid} ${Array(17).fill('0').join(' ')} 1940000\n`); }
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.deepEqual(snapshot.services.items.map((item) => item.label).sort(), ['Artifact server', 'Atrium broker', 'HTTP server']);
  assert.deepEqual(snapshot.helpers.items.map((item) => item.pid), [600]);
  assert.deepEqual(snapshot.services.items.map((item) => item.pid).sort(), [610, 620, 630]);
});

await test('[services] an ageless artifact-server bind loser does not duplicate the live server', async () => {
  const isolated = join(root, 'artifact-server-bind-race');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', clockTicks: 100 };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true }); mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true }); mkdirSync(isolatedPaths.procRoot, { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, 'uptime'), '20000.00 1000.00\n');
  for (const pid of [630, 631]) {
    mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true });
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), 'Name:\tnode\nPPid:\t1\n');
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), ['node', '/plugin/bin/wt-artifact-server.mjs', 'serve'].join('\0') + '\0');
  }
  writeFileSync(join(isolatedPaths.procRoot, '630', 'stat'), `630 (node) S 1 ${Array(17).fill('0').join(' ')} 1880000\n`);

  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.deepEqual(snapshot.services.items, [{ id: 'service:630', pid: 630, label: 'Artifact server', age: '20 min' }]);
});

await test('[Step 8 round 2 jitter] newly started matching processes are not long-lived services', async () => {
  const isolated = join(root, 'transient-service');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', clockTicks: 100 };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true }); mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true }); mkdirSync(isolatedPaths.procRoot, { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, 'uptime'), '20000.00 1000.00\n');
  for (const [pid, startTicks] of [[690, 1999500], [691, 1990000]]) {
    mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true });
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), 'Name:\tpython3\nPPid:\t1\n');
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), `python3\0-m\0http.server\0${pid}\0`);
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'stat'), `${pid} (python fixture) S 1 ${Array(17).fill('0').join(' ')} ${startTicks}\n`);
  }
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.deepEqual(snapshot.services.items.map((item) => item.pid), [691]);
});

await test('[Arbiter fix 3 launcher] detached lanes explicitly report absent durable launcher evidence', async () => {
  const isolated = join(root, 'detached-launcher');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const worktree = join(isolatedPaths.suiteRoot, 'worktrees', 'detached'); mkdirSync(join(worktree, '.lane'), { recursive: true });
  writeFileSync(join(worktree, '.lane', 'brief.md'), '# Brief: card 1862698281071544163: Detached lane\n'); writeFileSync(join(worktree, '.lane', 'run.log'), 'working\n');
  mkdirSync(join(isolatedPaths.procRoot, '700'), { recursive: true }); writeFileSync(join(isolatedPaths.procRoot, '700', 'status'), 'PPid:\t1\n'); writeFileSync(join(isolatedPaths.procRoot, '700', 'cmdline'), ['opencode', 'run', '--dir', worktree, '--model', 'gpt'].join('\0') + '\0');
  const session = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions[0];
  assert.equal(session.launcher, 'launched by: unknown'); assert.equal(session.launcherEvidence, 'none');
});

await test('[Arbiter fix 4 lane title] duplicate brief and card titles collapse to a bare Lane in snapshots', async () => {
  const isolated = join(root, 'duplicate-lane-title');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const id = '1862698281071544164'; const worktree = join(isolatedPaths.suiteRoot, 'worktrees', 'same-title'); mkdirSync(join(worktree, '.lane'), { recursive: true });
  writeFileSync(join(worktree, '.lane', 'brief.md'), `# Brief — card ${id}: Ship the same title\n`); writeFileSync(join(worktree, '.lane', 'run.log'), 'working\n');
  mkdirSync(join(isolatedPaths.procRoot, '710'), { recursive: true }); writeFileSync(join(isolatedPaths.procRoot, '710', 'status'), 'PPid:\t1\n'); writeFileSync(join(isolatedPaths.procRoot, '710', 'cmdline'), ['opencode', 'run', '--dir', worktree, '--model', 'gpt'].join('\0') + '\0');
  const card = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions[0].cards[0];
  assert.equal(card.title, 'Ship the same title'); assert.equal(card.actors[0].title, null); assert.equal(card.actors[0].role, null);
  const source = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'real-snapshot.mjs'), 'utf8');
  assert.match(source, /const description = actor\.role \|\| actor\.title/); assert.doesNotMatch(source, /actor\.role \|\| actor\.title \|\| actor\.id/);
});

await test('[WIR5-04 changed][Step 5 DoD 6] failed tmux creation never kills a foreign session', async () => {
  const script = join(fileURLToPath(new URL('.', import.meta.url)), 'host-e2e.sh');
  const mockDir = join(root, 'mock-tmux'); const log = join(mockDir, 'calls.log'); mkdirSync(mockDir, { recursive: true });
  const claude = join(mockDir, 'claude'); writeFileSync(claude, '#!/usr/bin/env bash\nexit 0\n'); chmodSync(claude, 0o755);
  const tmux = join(mockDir, 'tmux'); writeFileSync(tmux, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$MOCK_TMUX_LOG"\n[[ "$1" != "new-session" ]]\n'); chmodSync(tmux, 0o755);
  assert.throws(() => execFileSync('bash', [script], { env: { ...process.env, PATH: `${mockDir}:${process.env.PATH}`, MOCK_TMUX_LOG: log }, stdio: 'pipe' }));
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /^new-session -d -s wir-e2e-\d+-\d+-\d+ /);
  assert.doesNotMatch(calls, /kill-session/);
});

await test('[blank pane fix host matcher] blank capture fails and rendered pane capture passes', async () => {
  const blank = new URL('./fixtures/host-capture-blank.txt', import.meta.url).pathname;
  const good = new URL('./fixtures/host-capture-rendered.txt', import.meta.url).pathname;
  assert.equal(captureHasPane(readFileSync(blank, 'utf8')), false);
  assert.equal(captureHasPane(readFileSync(good, 'utf8')), true);
  const matcher = join(hookDir, 'host-capture-match.mjs');
  assert.throws(() => execFileSync(process.execPath, [matcher, blank], { stdio: 'pipe' }));
  assert.doesNotThrow(() => execFileSync(process.execPath, [matcher, good], { stdio: 'pipe' }));
});

const hooks = [];
const calls = [];
const timers = [];
const stored = new Map();
const element = (name) => (props = {}) => {
  validateElementProps(name, props);
  return { name, props };
};
function findButton(node, label) {
  if (!node || typeof node !== 'object') return null;
  if (node.name === 'Button' && JSON.stringify(node.props.children).includes(label)) return node;
  for (const child of [node.props?.children].flat(2)) { const found = findButton(child, label); if (found) return found; }
  return null;
}
function linkText(node) {
  return node?.props?.label || [node?.props?.children].flat(2).filter(Boolean).join('');
}
function hasDescendant(node, predicate) {
  if (!node || typeof node !== 'object') return false;
  if (predicate(node)) return true;
  return [node.props?.children].flat(2).some((child) => hasDescendant(child, predicate));
}
function descendants(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const child of [node.props?.children].flat(2)) descendants(child, predicate, found);
  return found;
}
function assertClickableColourAndToggleMarkers(tree) {
  const visit = (node, coloured = false) => {
    if (!node || typeof node !== 'object') return;
    const hasColour = coloured || ['color', 'backgroundColor', 'borderColor'].some((key) => Boolean(node.props?.[key]));
    if (node.name === 'Button' || node.name === 'Link') assert(hasColour || Boolean(node.props.hover?.color), `${node.name} ${node.props.key || node.props.label || ''} has no colour`);
    if (node.name === 'Button' && String(node.props.key || '').startsWith('detail-toggle:')) {
      const label = node.props.children.join('');
      const open = descendants(tree, (item) => item.name === 'Box' && item.props.key === `open-${node.props.key}`).length > 0;
      assert.match(label, open ? /^\[▼ / : /^\[▶ /, `${node.props.key}: ${label}`);
    }
    for (const child of [node.props?.children].flat(2)) visit(child, hasColour);
  };
  visit(tree);
}
function assertNoUnknownText(node) {
  for (const text of descendants(node, (item) => item.name === 'Text')) {
    assert.doesNotMatch(text.props.children.map(String).join(''), /\bunknown\b/i);
  }
}
const $ = {
  process: processCapability,
  store: { get: async (key) => stored.get(key), set: async (key, value) => { stored.set(key, value); calls.push(['store', key, value]); } },
  command: { register: async (spec) => calls.push(['register', spec]) },
  clock: {
    every: (ms, fn) => { const timer = { ms, fn, cancelled: false, cancel: () => { timer.cancelled = true; calls.push(['cancel']); } }; timers.push(timer); return timer; },
  },
  ui: {
    open: async (pane) => calls.push(['open', pane]),
    close: async (pane) => calls.push(['close', pane]),
    invalidate: (event) => calls.push(['invalidate', event]),
    resolve: async () => ({ Box: element('Box'), Text: element('Text'), Button: element('Button'), Link: element('Link'), Code: element('Code') }),
    log: async (text) => calls.push(['log', text]),
  },
};
register((event, matcher, hook) => hooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), paths);
const hookFor = (event, predicate = () => true) => hooks.find((hook) => hook.event === event && predicate(hook));
const forwarded = async (hook, event, outcome = { downstream: true }) => {
  let count = 0;
  const result = await hook.hook($, event, async () => { count += 1; return outcome; });
  return { count, result };
};
const renderedPaneText = async () => {
  await forwarded(hookFor('command.run'), { command: 'wir' });
  const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
  let rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120 } });
  findButton(rendered.result, 'Show all projects')?.props.onPress();
  rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120 } });
  return JSON.stringify(rendered.result, (_key, value) => typeof value === 'function' ? '[function]' : value);
};
const renderSnapshot = async (snapshot, sessionCwd = null, preserveUnknown = false, bodyColumns = 80) => {
  const declaredProject = snapshot.sessions?.find((session) => typeof session.project === 'string' && session.project !== 'unknown')?.project
    || snapshot.rows?.find((row) => typeof row.project === 'string' && row.project !== 'unknown')?.project;
  const effectiveCwd = sessionCwd || (declaredProject ? `/fixture/${declaredProject}` : worktree);
  const fixtureProject = effectiveCwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
  const attributed = {
    ...snapshot,
    ...(Array.isArray(snapshot.sessions) ? { sessions: snapshot.sessions.map((session) => preserveUnknown || session.project ? session : { ...session, project: fixtureProject }) } : {}),
    ...(!Array.isArray(snapshot.sessions) && Array.isArray(snapshot.rows) ? { rows: snapshot.rows.map((row) => preserveUnknown || row.project ? row : { ...row, project: fixtureProject }) } : {}),
  };
  const localHooks = [];
  const local$ = {
    ...$,
    process: { run: async () => ({ exitCode: 0, stdout: JSON.stringify(attributed), stderr: '' }) },
    ui: { ...$.ui },
  };
  register((event, matcher, hook) => localHooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), paths);
  const find = (event, predicate = () => true) => localHooks.find((hook) => hook.event === event && predicate(hook));
  await find('session.start').hook(local$, { cwd: effectiveCwd }, async () => ({}));
  await find('command.run').hook(local$, { command: 'wir' }, async () => ({}));
  const pane = find('ui.render', (hook) => hook.matcher?.component === 'Pane');
  const tree = await pane.hook(local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns } }, async () => ({}));
  return { tree, pane, local$, find };
};

await test('[project scope DoD 1-3] default shows this project, state, and hidden unattributed count; toggle shows all', async () => {
  const snapshot = {
    discovery: 'available', rows: [], sessions: [
      { id: 'session:current', project: 'card-one', cards: [{ id: '1862698281071544001', title: 'CURRENT_PROJECT_CARD', actors: [] }], actors: [] },
      { id: 'session:cloud', project: 'cloud', cards: [{ id: '1862698281071544002', title: 'OTHER_PROJECT_CARD', actors: [] }], actors: [] },
      { id: 'session:unknown', project: null, cards: [], actors: [{ id: 'unknown-work', kind: 'external', label: 'Lane', title: 'UNATTRIBUTED_WORK' }] },
    ], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now,
  };
  const rendered = await renderSnapshot(snapshot, null, true);
  let tree = rendered.tree;
  let text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert(text.includes('CURRENT_PROJECT_CARD'));
  assert(!text.includes('OTHER_PROJECT_CARD'));
  assert(!text.includes('UNATTRIBUTED_WORK'));
  assert(text.includes('Scope: this project · card-one'));
  assert(text.includes('2 items hidden · 1 unattributed'));
  const showAll = findButton(tree, 'Show all projects');
  assert(showAll, 'show-all toggle');
  showAll.props.onPress();
  tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert(text.includes('CURRENT_PROJECT_CARD'));
  assert(text.includes('OTHER_PROJECT_CARD'));
  assert(text.includes('UNATTRIBUTED_WORK'));
  assert(text.includes('Scope: all projects'));
  assert(findButton(tree, 'Show this project'));
});

await test('[project scope DoD 4] absent root options resolve from session config and project root', async () => {
  const localHooks = [];
  let collectorConfig;
  const sessionCwd = '/workspace/cloud';
  const local$ = {
    ...$,
    env: { get: async (name) => name === 'CLAUDE_CONFIG_DIR' ? '/config/claude' : undefined },
    process: { run: async (argv) => {
      collectorConfig = JSON.parse(argv.at(-1));
      return { exitCode: 0, stdout: JSON.stringify({ discovery: 'available', rows: [], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] } }), stderr: '' };
    } },
    store: { get: async () => false, set: async () => {} },
    ui: { ...$.ui },
  };
  register((event, matcher, hook) => localHooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), { livenessDir, procRoot });
  const find = (event, predicate = () => true) => localHooks.find((hook) => hook.event === event && predicate(hook));
  await find('session.start').hook(local$, { cwd: sessionCwd }, async () => ({}));
  await find('command.run').hook(local$, { command: 'wir' }, async () => ({}));
  assert.equal(collectorConfig.configDir, '/config/claude');
  assert.equal(collectorConfig.suiteRoot, '/workspace/cloud/.claude');
  await find('session.start').hook(local$, { cwd: 'C:\\workspace\\cloud' }, async () => ({}));
  await find('command.run').hook(local$, { command: 'wir' }, async () => ({}));
  assert.equal(collectorConfig.suiteRoot, 'C:\\workspace\\cloud\\.claude');
  const pluginFile = join(pluginRoot, '.claude-plugin', 'plugin.json');
  const userConfig = JSON.parse(readFileSync(pluginFile, 'utf8')).userConfig;
  assert.equal(userConfig.configDir.default, '');
  assert.equal(userConfig.suiteRoot.default, '');
});

await test('[E-2 pane] capped discovery renders one certainty warning instead of an empty-state claim', async () => {
  const { tree } = await renderSnapshot(cappedDiscoverySnapshot);
  const text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert(text.includes(`discovery partial (scan cap reached: ${cappedDiscoverySnapshot.cappedScans[0]})`));
  assert(!text.includes('Nothing running in the background.'));
});
await test('[allowed roots pane] a refused live actor explains reduced certainty without exposing its path', async () => {
  const refusedPath = join(root, 'must-not-render');
  const snapshot = { discovery: 'partial', pathRefusals: ['liveness live actor path was outside allowed roots'], rows: [], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, items: [] }, collectedAt: paths.now };
  const { tree } = await renderSnapshot(snapshot);
  const text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert(text.includes('discovery partial (liveness live actor path was outside allowed roots)'));
  assert(!text.includes(refusedPath));
  assert(!text.includes('Nothing running in the background.'));
});
const renderProvidedSnapshot = async (snapshot, phaseLabel) => {
  const rendered = await renderSnapshot(snapshot);
  let { tree } = rendered;
  findButton(tree, phaseLabel).props.onPress();
  tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  return tree;
};

await test('[changed Round 2 affordance][Arbiter fix 2 collapsed services] service and idle-helper details start collapsed on separate lines', async () => {
  const snapshot = { discovery: 'available', rows: [], sessions: [], services: { count: 1, items: [{ id: 'service:1', label: 'Atrium broker', age: '2 h 0 min' }] }, helpers: { count: 1, oldest: '20 min', items: [{ id: 'helper:2', label: 'Codex app-server', age: '20 min' }] }, collectedAt: paths.now };
  const rendered = await renderSnapshot(snapshot);
  const { tree } = rendered;
  const text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(text, /Services \(1\)/); assert.match(text, /Idle helpers \(1; oldest 20 min\)/); assert(!text.includes('Atrium broker ·')); assert(!text.includes('Codex app-server ·'));
  const rowButtons = descendants(tree, (item) => item.name === 'Button' && String(item.props.key).startsWith('detail-toggle:row:'));
  assert.equal(rowButtons.length, 2);
  for (const button of rowButtons) button.props.onPress();
  const expanded = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  assert(hasDescendant(expanded, (item) => item.name === 'Text' && item.props.children.includes('Atrium broker · 2 h 0 min')));
  assert(hasDescendant(expanded, (item) => item.name === 'Text' && item.props.children.includes('Codex app-server · 20 min')));
});

await test('[changed Round 2 wrapping][blank pane fix][WIR5-05 changed][Step 5 DoD 5] row shrink policy is carried by wrapping Boxes at 80 columns', async () => {
  const snapshot = { discovery: 'available', rows: [], sessions: [{ id: 'session:1', launcher: 'Claude pid 1', cards: [{ id: '1862698281071544133', cardUrl: null, title: 'Narrow card', actors: [{ id: 'lane:1', kind: 'external', label: 'Review lane', role: 'Security review', title: 'Security review', model: 'gpt', activity: '→ Read a/very/long/file', elapsed: '3 min' }] }], actors: [] }], helpers: { count: 1, oldest: '8 min', items: [{ id: 'helper:2', label: 'HTTP server', age: '8 min' }] }, collectedAt: paths.now };
  const { tree } = await renderSnapshot(snapshot);
  const labels = ['Session', 'Card', 'Review lane'];
  for (const label of labels) assert(hasDescendant(tree, (item) => item.name === 'Box' && item.props.flexShrink === 0
    && hasDescendant(item, (child) => child.name === 'Text' && child.props.children.some((value) => String(value).includes(label)))), label);
  assert(findButton(tree, 'Idle helpers (1; oldest 8 min)'));
  const rows = descendants(tree, (item) => item.name === 'Box' && item.props.flexDirection === 'row');
  for (const row of rows) for (const child of [row.props.children].flat(2)) {
    if (child?.name === 'Text') assert(Object.hasOwn(child.props, 'wrap'), JSON.stringify(child.props.children));
  }
});

await test('[WIR5-06 pane] partial process discovery is visible as one dim diagnostic line', async () => {
  for (const reason of ['capped', 'unreadable']) {
    const { tree } = await renderSnapshot({ discovery: 'available', processDiscovery: 'partial', processPartialReason: reason, rows: [], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, items: [] }, collectedAt: paths.now });
    const messages = descendants(tree, (item) => item.name === 'Text' && item.props.children.includes(`process list partial (${reason})`));
    assert.equal(messages.length, 1); assert.equal(messages[0].props.dimColor, true);
  }
});

await test('[missed CLI mismatch] real-snapshot prints row.lanes with actor indentation', async () => {
  const source = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'real-snapshot.mjs'), 'utf8');
  const fixture = { discovery: 'available', sessions: [{ launcher: 'Claude pid 1', cards: [{ id: '1862698281071544167', title: 'Card', actors: [{ label: 'Pilot', lanes: [{ label: 'Lane', title: 'Nested CLI lane' }] }] }], actors: [] }], services: { count: 0, items: [] }, helpers: { count: 0, items: [] } };
  const runnable = source.replace(/^import .*$/gm, '').replace(/const snapshot = await readSnapshot\([\s\S]*?\}, paths\);/, `const snapshot = ${JSON.stringify(fixture)};`);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', runnable], { encoding: 'utf8' });
  assert.match(output, /^      Lane · Nested CLI lane/m);
});

await test('[Round 7 real snapshot] partial discovery prints its capped scan and exits successfully', async () => {
  const source = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'real-snapshot.mjs'), 'utf8');
  const fixture = { discovery: 'partial', cappedScans: ['/fixture/capped-scan'], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, items: [] } };
  const runnable = source.replace(/^import .*$/gm, '').replace(/const snapshot = await readSnapshot\([\s\S]*?\}, paths\);/, `const snapshot = ${JSON.stringify(fixture)};`);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', runnable], { encoding: 'utf8' });
  assert.match(output, /^Discovery: partial \(scan cap reached: \/fixture\/capped-scan\)$/m);
});

await test('session start registers /wir and forwards', async () => {
  const seen = await forwarded(hookFor('session.start'), { cwd: root });
  assert.equal(seen.count, 1);
  assert(calls.some(([kind, spec]) => kind === 'register' && spec.name === 'wir'));
});
await test('collector input omits the dead session cwd', async () => {
  const originalRun = processCapability.run;
  let collectorConfig;
  try {
    processCapability.run = async (argv) => {
      collectorConfig = JSON.parse(argv.at(-1));
      return originalRun(argv);
    };
    await forwarded(hookFor('command.run'), { command: 'wir' });
    assert(!Object.hasOwn(collectorConfig, 'cwd'));
  } finally {
    processCapability.run = originalRun;
  }
});
await test('render is absent when not requested', async () => {
  const seen = await forwarded(hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane'), { component: 'Pane', requestId: 'other', surface: 'terminal' });
  assert.equal(seen.count, 1);
  assert.deepEqual(seen.result, { downstream: true });
});
await test('[changed Round 3 exact host close][changed Round 2 Close] /wir answers itself without next, opens, and Close cross closes', async () => {
  const command = hookFor('command.run');
  const opened = await forwarded(command, { command: 'wir' });
  assert.equal(opened.count, 0, 'a plugin command has nothing downstream: calling next yields the engine\'s "no hook answered"');
  assert.equal(typeof opened.result?.text, 'string');
  assert(calls.some(([kind, pane]) => kind === 'open' && pane.id === 'wt-what-is-running'));
  const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
  const rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120 } });
  assert.equal(rendered.count, 1);
  const close = JSON.stringify(rendered.result, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(close, /Close/);
  const closing = findButton(rendered.result, 'Close').props.onPress();
  assert(closing instanceof Promise, 'Button returns the exact asynchronous host close path');
  await closing;
  assert(calls.some(([kind, pane]) => kind === 'close' && pane.id === 'wt-what-is-running'));
  assert(timers.at(-1).cancelled);
});
await test('[Step 7 round 5 finding 1] failure and reasonless partial panes never render unknown', async () => {
  const originalRun = processCapability.run;
  try {
    processCapability.run = async () => ({ exitCode: 1, stdout: '', stderr: 'failed' });
    await forwarded(hookFor('command.run'), { command: 'wir' });
    const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
    const unavailable = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' });
    const unavailableText = JSON.stringify(unavailable.result, (_key, value) => typeof value === 'function' ? '[function]' : value);
    assertNoUnknownText(unavailable.result);
    assert.match(unavailableText, /collector failed/);
    assert(!unavailableText.includes('Nothing running in the background.'));
    processCapability.run = async () => ({ exitCode: 0, stdout: JSON.stringify({ discovery: 'partial', rows: [], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, items: [] }, collectedAt: paths.now }), stderr: '' });
    await forwarded(hookFor('command.run'), { command: 'wir' });
    const partial = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' });
    assertNoUnknownText(partial.result);
    assert(hasDescendant(partial.result, (item) => item.name === 'Text' && item.props.children.includes('Discovery is partial.')));
    processCapability.run = async () => ({ exitCode: 0, stdout: JSON.stringify({ discovery: 'available', rows: [], collectedAt: paths.now }), stderr: '' });
    await forwarded(hookFor('command.run'), { command: 'wir' });
    const empty = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' });
    assert.match(JSON.stringify(empty.result, (_key, value) => typeof value === 'function' ? '[function]' : value), /Nothing running in the background\./);
  } finally {
    processCapability.run = originalRun;
  }
});
await test('[collector seam][A-1][E-1] a sole finished SDK run does not claim emptiness when process discovery is unavailable', async () => {
  const originalRun = processCapability.run;
  try {
    processCapability.run = async () => ({ exitCode: 0, stdout: JSON.stringify(finishedOnlySnapshot), stderr: '' });
    await forwarded(hookFor('command.run'), { command: 'wir' });
    const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
    const rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' });
    const text = JSON.stringify(rendered.result, (_key, value) => typeof value === 'function' ? '[function]' : value);
    assert.match(text, /process discovery unavailable \(unavailable on this platform\)/);
    assert(!text.includes('Nothing running in the background.'));
    assert(!text.includes('1862698281071544194'));
  } finally {
    processCapability.run = originalRun;
  }
});
await test('[changed Step 7 indentation][changed Step 5 naming][A-3][DoD 1] wave pilots nest only independently evidenced live lanes', async () => {
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  const pilot = snapshot.rows.find((row) => row.id === waveCardId);
  assert.equal(pilot.waveId, waveId);
  assert.equal(pilot.kind, 'pilot');
  assert.equal(pilot.lanes.length, 1);
  assert.equal(pilot.lanes[0].parentCardId, waveCardId);
  const { tree } = await renderSnapshot(snapshot);
  const text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(text, new RegExp(`Wave ${waveId}`));
  assert.match(text, new RegExp(`detail-toggle:row:${waveCardId}`));
  assert.match(text, new RegExp(`cards/${waveCardId}`));
  assert.match(text, /Lane/);
  const pilotTree = descendants(tree, (item) => item.name === 'Box' && item.props.key === `pilot:${waveCardId}`)[0];
  assert(hasDescendant(pilotTree, (item) => item.name === 'Box' && item.props.key?.startsWith('lane:') && item.props.paddingLeft === 1));
  const standalone = snapshot.rows.find((row) => row.id === liteCardId);
  assert.equal(standalone.waveId, null);
});
await test('[changed Step 8 selectable phases][DoD 3] known phase lines retain words and glyphs while inactive phases are plain', async () => {
  const text = await renderedPaneText();
  assert(!/phase:[^"}]*:implementation/.test(text));
  assert(!/phase:[^"}]*:gates/.test(text));
  assert.match(text, /\[▶ Discovery ✓\].*done/);
  assert.match(text, /\[▶ Critic ●\].*running/);
  assert.match(text, /Plan –.*skipped/);
  assert.match(text, /Critic –.*skipped/);
  assert.match(text, /TDD ·.*not started/);
  assert(!/\[Plan –\]|\[Critic –\]|\[TDD ·\]/.test(text));
  assert.match(text, /Plan ↔ Critic: 1 round/);
});
await test('[changed Step 7 unknown omission][DoD 3] unknown phase has no phase text, buttons, or count', async () => {
  const snapshot = { discovery: 'available', rows: [{ id: 'unknown-row', kind: 'pilot', title: 'unknown-row', phase: 'unknown', phaseStates: {}, outcome: 'running', gates: {}, review: {}, inspectors: {}, lanes: [], sources: {} }], collectedAt: paths.now };
  const { tree } = await renderSnapshot(snapshot);
  const text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert(!text.includes('phase unknown'));
  assert.equal(descendants(tree, (item) => item.name === 'Button' && String(item.props.key || '').startsWith('phase:')).length, 0);
  assert(!text.includes('not started'));
});
await test('[lifecycle source] structured timeline renders the work-stage row', async () => {
  const text = JSON.stringify((await renderSnapshot(structuredLifecycleSnapshot)).tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(text, /Work stages:/);
  assert.doesNotMatch(text, /from log/);
});
await test('[lifecycle fallback] log-derived stages say where they came from', async () => {
  const snapshot = { discovery: 'available', rows: [{
    id: 'log-fallback', kind: 'pilot', title: 'log-fallback', phase: 'tdd', phaseSource: 'log',
    phaseStates: { discovery: 'done', tdd: 'running' }, outcome: 'running', gates: {}, review: {}, inspectors: {}, lanes: [], sources: {},
  }], collectedAt: paths.now };
  const text = JSON.stringify((await renderSnapshot(snapshot)).tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(text, /Work stages \(from log\):/);
});
await test('[DoD 4] phase state is carried by words and the running glyph, not colour', async () => {
  const snapshot = { discovery: 'available', rows: [{
    id: 'styled', kind: 'pilot', title: 'styled', phase: 'tdd', outcome: 'failed',
    phaseStates: { discovery: 'done', plan: 'skipped', tdd: 'running' }, gates: {}, review: {}, inspectors: {}, lanes: [], sources: {},
  }], collectedAt: paths.now };
  const { tree } = await renderSnapshot(snapshot);
  assert(!hasDescendant(tree, (item) => item.name === 'Button' && item.props.children.join('').includes('●')));
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.children.join('').includes('running') && item.props.bold === true && !item.props.color));
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.children.join('').includes('skipped') && !item.props.color));
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.children.join('').includes('failed') && item.props.color && item.props.bold === true));
});
await test('[R1] every Button in the whole rendered tree has only string children', async () => {
  const snapshot = { discovery: 'available', rows: [{
    id: 'leaf-buttons', kind: 'pilot', title: 'leaf-buttons', phase: 'tdd', outcome: 'failed',
    phaseStates: { discovery: 'done', plan: 'skipped', tdd: 'running' }, gates: {}, review: {}, inspectors: {}, lanes: [], sources: {},
  }], collectedAt: paths.now };
  const { tree } = await renderSnapshot(snapshot);
  const buttons = descendants(tree, (item) => item.name === 'Button');
  assert(buttons.length > 0);
  for (const button of buttons) {
    assert([button.props.children].flat(2).every((child) => typeof child === 'string'), String(button.props.key));
  }
});
await test('[changed Step 8 content gating][Missed A] lifecycle-only phases without evidence render as plain state text', async () => {
  const snapshot = { discovery: 'available', rows: [{
    id: 'lifecycle-only', kind: 'pilot', title: 'lifecycle-only', phase: 'verify', outcome: 'unknown',
    phaseStates: { discovery: 'skipped', plan: 'skipped', critic: 'skipped', tdd: 'skipped', verify: 'running', review: 'not started', refutation: 'not started', harden: 'not started', report: 'not started', awaiting_fidelity: 'not started' },
    gates: {}, review: {}, inspectors: {}, lanes: [], sources: {},
  }], collectedAt: paths.now };
  const { tree } = await renderSnapshot(snapshot);
  const text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert(!findButton(tree, 'Verify ●'));
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.children.some((child) => String(child).includes('Verify ●')) && item.props.bold === true && !item.props.color));
  assert.match(text, /Independent review ·.*not started/);
});
await test('[changed Round 2 wrapping][DoD 2][DoD 4] standalone external lanes state that phases are unavailable', async () => {
  const snapshot = { discovery: 'available', rows: [{
    id: 'lane:/tmp/external', kind: 'external', title: 'Ship the artifact server', phase: 'unknown', outcome: 'running', model: 'gpt-5.6', activity: 'last write 2 min ago', sources: {},
  }], collectedAt: paths.now };
  const { tree } = await renderSnapshot(snapshot);
  const text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(text, /External lane/); assert.match(text, /Ship the artifact server/); assert.match(text, /gpt-5\.6/); assert.match(text, /last write 2 min ago/);
  assert.match(text, /phases: n\/a \(plain lane\)/); assert(!text.includes('phase unknown')); assert(!text.includes('not started'));
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.children.includes('Ship the artifact server') && item.props.color && item.props.wrap === 'wrap'));
});
await test('[changed Step 7 plain card ID][Step 4 valid card URL] card IDs are bold Text and accepted URLs move to open-card detail Links', async () => {
  const id = '1862698281071544150';
  const rows = [
    { id, cardId: id, cardUrl: `https://boards.example.test/cards/${id}`, kind: 'pilot', title: 'Pilot title', phase: 'unknown', phaseStates: {}, outcome: 'running', gates: {}, review: {}, inspectors: {}, lanes: [], sources: {} },
    { id: 'lane:/tmp/linked', cardId: id, cardUrl: `https://boards.example.test/cards/${id}`, kind: 'external', title: 'External title', model: 'gpt', activity: 'active', sources: {} },
  ];
  const { tree } = await renderSnapshot({ discovery: 'available', rows, collectedAt: paths.now });
  const links = descendants(tree, (item) => item.name === 'Link' && linkText(item).includes('open card'));
  assert.equal(links.length, 2);
  assert(links.every((link) => hooksModule.isValidLinkHref(link.props.href)));
  assert.equal(descendants(tree, (item) => item.name === 'Link' && linkText(item).includes(id)).length, 0);
  assert.equal(descendants(tree, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes(id)).length, 2);
});
await test('[changed Step 7 bold card ID][Step 4 invalid card URL] rejected card URLs render IDs as bold Text without a detail Link', async () => {
  const id = '1862698281071544151';
  const { tree } = await renderSnapshot({ discovery: 'available', rows: [{
    id: 'lane:/tmp/invalid', cardId: id, cardUrl: `http://example.test/cards/${id}`, kind: 'external', title: 'External title', model: 'gpt', activity: 'active', sources: {},
  }], collectedAt: paths.now });
  assert.equal(descendants(tree, (item) => item.name === 'Link').length, 0);
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes(id)));
});
await test('[changed Step 7 bold card ID][Step 4 absent card URL] missing card URLs render IDs as bold Text without a detail Link', async () => {
  const id = '1862698281071544152';
  const { tree } = await renderSnapshot({ discovery: 'available', rows: [{
    id, cardId: id, cardUrl: null, kind: 'pilot', title: 'Pilot title', phase: 'unknown', phaseStates: {}, outcome: 'running', gates: {}, review: {}, inspectors: {}, lanes: [], sources: {},
  }], collectedAt: paths.now });
  assert.equal(descendants(tree, (item) => item.name === 'Link').length, 0);
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes(id)));
});
await test('[changed Step 8 open-detail header][changed Round 3 report sections][DoD 3] inspector extracts bounded summaries and selection survives refresh', async () => {
  await forwarded(hookFor('command.run'), { command: 'wir' });
  const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
  let rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120, scroll: { bodyRows: 30, offset: 0 } } });
  findButton(rendered.result, 'Show all projects').props.onPress();
  rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120, scroll: { bodyRows: 30, offset: 0 } } });
  findButton(rendered.result, 'Plan').props.onPress();
  rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120, scroll: { bodyRows: 30, offset: 0 } } });
  let text = JSON.stringify(rendered.result, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(text, /open-detail-toggle:stage:[^}]*:plan/);
  assert.match(text, /Use a bounded tree/);
  assert.match(text, /Build hierarchy/);
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  assert(snapshot.rows.find((row) => row.id === waveCardId).inspectors.plan.summary.length <= 2400);
  assert(snapshot.rows.find((row) => row.id === waveCardId).inspectors.plan.summary.split('\n').length <= 20);
  assert.match(snapshot.rows.find((row) => row.id === waveCardId).inspectors.critic.summary, /VERDICT: approved\nFirst finding summary\nSecond finding/);
  assert.equal(snapshot.rows.find((row) => row.id === waveCardId).inspectors.report.summary, 'Implemented\nNested layout shipped.');
  await timers.at(-1).fn();
  rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120, scroll: { bodyRows: 30, offset: 0 } } });
  text = JSON.stringify(rendered.result, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(text, /open-detail-toggle:stage:[^}]*:plan/);
  assert(!text.includes(`Full text: ${waveWorktree}`));
  assert(!text.includes('Open full plan.md'));
});
await test('[DoD 4] markdown rendering is safe and URL detection covers four platforms', async () => {
  assert.equal(typeof artifactHelpers.markdownToHtml, 'function');
  assert.equal(typeof artifactHelpers.detectArtifactUrl, 'function');
  const html = artifactHelpers.markdownToHtml('# Heading\n\n<script>"owned"</script> **bold** `code`\n');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /&lt;script&gt;&quot;owned&quot;&lt;\/script&gt;/);
  assert(!html.includes('<script>'));
  assert.equal(artifactHelpers.detectArtifactUrl('/tmp/a b.md', 'linux', {}, ''), 'file:///tmp/a%20b.md');
  assert.equal(artifactHelpers.detectArtifactUrl('/tmp/a.md', 'linux', { WSL_DISTRO_NAME: 'Ubuntu' }, ''), 'file://wsl.localhost/Ubuntu/tmp/a.md');
  assert.equal(artifactHelpers.detectArtifactUrl('/Users/me/a.md', 'darwin', {}, ''), 'file:///Users/me/a.md');
  assert.equal(artifactHelpers.detectArtifactUrl('C:\\work\\a.md', 'win32', {}, ''), 'file:///C:/work/a.md');
  assert.equal(artifactHelpers.detectArtifactUrl(join(suiteRoot, 'worktrees', 'a b.md'), 'linux', {}, 'http://localhost:9000/files', suiteRoot), 'http://localhost:9000/files/worktrees/a%20b.md');
  assert.equal(artifactHelpers.detectArtifactUrl('/tmp/a.md', 'linux', {}, 'http://localhost:9000/files', suiteRoot), null);
  const snapshot = await readSnapshot({ process: processCapability }, paths);
  const artifact = snapshot.rows.find((row) => row.id === waveCardId).inspectors.plan;
  assert.match(artifact.href, /plan\.md\.html$/);
  assert.match(readFileSync(join(waveWorktree, '.lane', 'plan.md.html'), 'utf8'), /<h2>ADR<\/h2>/);
  const before = statSync(join(waveWorktree, '.lane', 'plan.md.html')).mtimeMs;
  await readSnapshot({ process: processCapability }, paths);
  assert.equal(statSync(join(waveWorktree, '.lane', 'plan.md.html')).mtimeMs, before);
});
await test('[Arbiter 1.1] Link href validator mirrors the declared host rule', async () => {
  assert.equal(typeof hooksModule.isValidLinkHref, 'function');
  for (const href of [
    'https://example.com/',
    'https://example.com/a%20b?value=%40',
    'http://localhost/',
    'http://localhost:8080/path',
    'http://127.0.0.1:9000/path',
  ]) assert.equal(hooksModule.isValidLinkHref(href), true, href);
  for (const href of [
    'file:///tmp/report.html',
    'https://example.com/a b',
    'http://example.com/',
    'https://user:pass@example.com/',
    'https://example.com/@raw',
    `https://example.com/caf${String.fromCharCode(31)}`,
    'https://example.com/café',
    'https://example.com',
    `https://example.com/${'a'.repeat(2049)}`,
  ]) assert.equal(hooksModule.isValidLinkHref(href), false, href);
});
await test('[changed Step 8 artifact action] default artifact target is omitted and option documents safe bases', async () => {
  await forwarded(hookFor('command.run'), { command: 'wir' });
  const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
  let rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' });
  findButton(rendered.result, 'Show all projects').props.onPress();
  rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' });
  findButton(rendered.result, 'Plan').props.onPress();
  rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' });
  assert(!hasDescendant(rendered.result, (item) => item.name === 'Text' && item.props.children.includes(`Full text: ${join(waveWorktree, '.lane', 'plan.md')}`)));
  assert(!hasDescendant(rendered.result, (item) => item.name === 'Link' && linkText(item).startsWith('Open ')));
  const pluginFile = join(pluginRoot, '.claude-plugin', 'plugin.json');
  const description = JSON.parse(readFileSync(pluginFile, 'utf8')).userConfig.linkBase.description;
  assert.match(description, /https:/);
  assert.match(description, /http:\/\/localhost/);
  assert.match(description, /static server/i);
});
await test('[changed: card and artifact links] every rendered Link href is validator-approved with default and linkBase', async () => {
  const renderFixture = async (linkBase) => {
    const localHooks = [];
    const local$ = { ...$, ui: { ...$.ui } };
    register((event, matcher, hook) => localHooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), { ...paths, linkBase });
    const find = (event, predicate = () => true) => localHooks.find((hook) => hook.event === event && predicate(hook));
    await find('session.start').hook(local$, { cwd: root }, async () => ({}));
    await find('command.run').hook(local$, { command: 'wir' }, async () => ({}));
    const pane = find('ui.render', (hook) => hook.matcher?.component === 'Pane');
    let tree = await pane.hook(local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
    findButton(tree, 'Show all projects').props.onPress();
    tree = await pane.hook(local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
    findButton(tree, 'Plan').props.onPress();
    tree = await pane.hook(local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
    return tree;
  };
  const defaultTree = await renderFixture('');
  const linkedTree = await renderFixture('https://artifacts.example.test/suite');
  const defaultLinks = descendants(defaultTree, (item) => item.name === 'Link');
  assert(defaultLinks.length > 0);
  assert(!defaultLinks.some((link) => linkText(link).startsWith('Open ')));
  for (const link of defaultLinks) assert.equal(hooksModule.isValidLinkHref(link.props.href), true, link.props.href);
  const links = descendants(linkedTree, (item) => item.name === 'Link');
  assert(links.length > defaultLinks.length);
  for (const link of links) assert.equal(hooksModule.isValidLinkHref(link.props.href), true, link.props.href);
});
await test('[changed Step 8 artifact action][A-5] an artifact outside suiteRoot renders no action-looking text', async () => {
  const row = {
    id: '1862698281071544148', title: 'outside', waveId: null, phase: 'critic', phaseStates: { plan: 'done', critic: 'running' },
    gates: {}, review: {}, inspectors: { plan: { summary: 'Outside summary', source: '/outside/.lane/plan.md', artifact: 'plan.md', href: null } }, lanes: [], sources: {},
  };
  const tree = await renderProvidedSnapshot({ discovery: 'available', rows: [row], collectedAt: paths.now }, 'Plan');
  assert(!hasDescendant(tree, (item) => item.name === 'Text' && item.props.children.includes('/outside/.lane/plan.md')));
  assert.equal(descendants(tree, (item) => item.name === 'Link').length, 0);
});
await test('[changed Step 8 action label][E-3] a truncated HTML artifact uses the same real report Link', async () => {
  const isolated = join(root, 'truncated-artifact');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now, linkBase: 'http://localhost:9000/files' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'large-plan', '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId: '1862698281071544149', route: 'FULL' }));
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=plan\nlifecycle: accepted phase=critic\n');
  writeFileSync(join(lane, 'plan.md'), '# Large\n' + 'x'.repeat(128 * 1024));
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const artifact = snapshot.rows.find((row) => row.id === '1862698281071544149').inspectors.plan;
  assert.equal(artifact.truncated, true);
  assert.equal(hooksModule.isValidLinkHref(artifact.href), true);
  const rendered = await renderSnapshot({ discovery: 'available', rows: [snapshot.rows.find((row) => row.id === '1862698281071544149')], collectedAt: paths.now });
  const plan = descendants(rendered.tree, (item) => item.name === 'Button' && String(item.props.key).endsWith(':plan'))[0];
  assert(plan, 'evidenced Plan stage button');
  plan.props.onPress();
  const tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  assert(hasDescendant(tree, (item) => item.name === 'Link' && linkText(item) === '[Open report]'));
  assert(!hasDescendant(tree, (item) => item.name === 'Link' && /Open (?:first|full)/.test(linkText(item))));
});
await test('[Arbiter 1.4] a wave with only finished pilot worktrees is omitted', async () => {
  const isolated = join(root, 'stale-wave');
  const isolatedPaths = {
    configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'),
    suiteRoot: join(isolated, 'suite'), now: paths.now,
  };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const id = '1862698281071544162';
  mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees', 'wave-stale', 'cards', id), { recursive: true });
  writeFileSync(join(isolatedPaths.suiteRoot, 'worktrees', 'wave-stale', 'cards', id, 'card.md'), `# Finished pilot\n\nCard id: ${id}\n`);
  const pilot = join(isolatedPaths.suiteRoot, 'worktrees', `card-${id}-wave-stale`, '.lane');
  mkdirSync(pilot, { recursive: true });
  writeFileSync(join(pilot, 'route.json'), JSON.stringify({ cardId: id, route: 'FULL' }));
  writeFileSync(join(pilot, 'runner-stdout.log'), 'lifecycle: accepted phase=report\nEXIT=0\n');
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.deepEqual(snapshot.rows, []);
});
await test('[changed: external activity is visible] default pilot rows omit operational noise while external lanes show activity', async () => {
  const text = await renderedPaneText();
  for (const noise of ['watchdog:', 'updated:', 'messages (GPT)', 'gates |', 'review |']) assert(!text.includes(noise));
  assert(!text.includes('usage | input:'));
  assert.match(text, /last write \d+ min ago/);
});
await test('[changed Round 2 Close][DoD 6] Close remains present with bounded inspector pane scrolling', async () => {
  const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
  const rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 80, scroll: { bodyRows: 8, offset: 12 } } });
  assert(findButton(rendered.result, 'Close'));
  const originalResolve = $.ui.resolve;
  try {
    $.ui.resolve = async () => ({ Box: element('Box'), Text: element('Text'), Button: element('Button') });
    const withoutLink = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 80, scroll: { bodyRows: 8, offset: 12 } } });
    assert(findButton(withoutLink.result, 'Close'));
  } finally {
    $.ui.resolve = originalResolve;
  }
});
await test('[changed Round 2 diagnostics] SDK row expansion hides internal sources, actors, and secret values', async () => {
  writeFileSync(join(livenessDir, 'agent-1.json'), JSON.stringify({ scope: 'card:1862698281071544189', complete: false, waitingOn: 'spawner', worktree, updatedAt: '2026-09-12T11:00:00Z', environment: { TOKEN: 'must-not-render' } }));
  const command = hookFor('command.run');
  await forwarded(command, { command: 'wir' });
  const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
  let rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120 } });
  findButton(rendered.result, 'Show all projects').props.onPress();
  rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120 } });
  descendants(rendered.result, (item) => item.name === 'Button').find((item) => item.props.key === `detail-toggle:row:${waveCardId}`).props.onPress();
  const expanded = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120 } });
  const text = JSON.stringify(expanded.result, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(text, new RegExp(waveCardId));
  for (const source of ['actors:', 'lifecycle:', 'spawnRegistry:', 'laneProbe:', 'liveness:', 'gateLogs:', 'reviews:', 'usage:']) assert(!text.includes(source));
  assert(!text.includes('must-not-render'));
});
await test('[changed Step 7 unknown omission][A-2] rendered truncated critic count is a lower bound', async () => {
  const text = await renderedPaneText();
  assert.match(text, /detail-toggle:row:1862698281071544178/);
  assert(!text.includes('phase unknown'));
  assert.match(text, /Plan ↔ Critic: at least 1 round/);
});
await test('[changed Round 3 phase wording][Missed zero rounds] rendered SDK row shows critic rounds: 0', async () => {
  const text = await renderedPaneText();
  assert.match(text, /detail-toggle:row:1862698281071544179/);
  assert.match(text, /· Plan/);
  assert(!text.includes('Plan ↔ Critic: 0 rounds'));
});
await test('[changed Round 3 terminal wording][B-1] rendered SDK outcome uses the real terminal lifecycle state', async () => {
  const text = await renderedPaneText();
  assert.match(text, /detail-toggle:row:1862698281071544190/);
  assert(!text.includes('· Awaiting fidelity'));
  assert.match(text, /Waiting for arbiter review/);
  const { tree } = await renderSnapshot(await readSnapshot({ process: processCapability }, paths));
  assert(!descendants(tree, (item) => item.name === 'Text').some((item) => item.props.children.some((child) => String(child).includes('awaiting_fidelity'))));
  assert(!/Awaiting fidelity[^}]*running/.test(text));
  assert.match(text, /Plan ↔ Critic: 2 rounds/);
  for (const id of ['1862698281071544191', '1862698281071544192', '1862698281071544193']) assert(!text.includes(id));
});
await test('surface button is added only when Button resolves and forwards', async () => {
  const promptHint = hookFor('ui.render', (hook) => hook.matcher?.component === 'PromptHint');
  const seen = await forwarded(promptHint, { component: 'PromptHint', surface: 'terminal' }, { name: 'Text', props: { children: ['hint'] } });
  assert.equal(seen.count, 1);
  assert.match(JSON.stringify(seen.result, (_key, value) => typeof value === 'function' ? '[function]' : value), /what is running/);
});
await test('[changed: stale spawn registry is not activity] an external row leaves within one poll after its lane exits', async () => {
  writeFileSync(join(worktree, '.lane', 'run.log'), 'working\nEXIT=0\n');
  await timers.at(-1).fn();
  const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
  const rendered = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 120 } });
  const text = JSON.stringify(rendered.result, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert(!text.includes(`lane (unknown, ${worktree})`));
  assert(!text.includes('pilot-one'));
});
await test('polling is 2 seconds and stops after host-side pane disposal', async () => {
  await forwarded(hookFor('command.run'), { command: 'wir' });
  const timer = timers.at(-1);
  assert.equal(timer.ms, 2000);
  const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
  await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' });
  await timer.fn();
  assert(!timer.cancelled);
  await timer.fn();
  assert(timer.cancelled);
});
await test('[per-session pane state] one registration never adopts another registration\'s open pane through shared storage', async () => {
  const sharedStore = new Map();
  const makeHost = () => {
    const localHooks = []; const localCalls = [];
    const local$ = {
      ...$,
      store: { get: async (key) => sharedStore.get(key), set: async (key, value) => { sharedStore.set(key, value); localCalls.push(['store', key, value]); } },
      ui: { ...$.ui, open: async (pane) => localCalls.push(['open', pane]), close: async (pane) => localCalls.push(['close', pane]) },
    };
    register((event, matcher, hook) => localHooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), paths);
    const find = (event, predicate = () => true) => localHooks.find((hook) => hook.event === event && predicate(hook));
    return { local$, localCalls, find };
  };
  const first = makeHost();
  await first.find('session.start').hook(first.local$, { cwd: worktree }, async () => ({}));
  await first.find('command.run').hook(first.local$, { command: 'wir' }, async () => ({}));
  assert.equal(sharedStore.has('pane-open'), false);
  const second = makeHost();
  await second.find('session.start').hook(second.local$, { cwd: worktree }, async () => ({}));
  assert(!second.localCalls.some(([kind]) => kind === 'open'));
  const secondPane = second.find('ui.render', (hook) => hook.matcher?.component === 'Pane');
  const untouched = await secondPane.hook(second.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({ downstream: true }));
  assert.deepEqual(untouched, { downstream: true });
  const pane = first.find('ui.render', (hook) => hook.matcher?.component === 'Pane');
  const tree = await pane.hook(first.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  findButton(tree, 'Close').props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert(first.localCalls.some(([kind]) => kind === 'close'));
  assert.equal(sharedStore.has('pane-open'), false);
});
await test('[per-session pane state] open, Close, and session start never access plugin-wide storage', async () => {
  const localHooks = []; const localCalls = [];
  const local$ = {
    ...$,
    store: { get: async () => { throw new Error('get rejected'); }, set: async () => { throw new Error('set rejected'); } },
    ui: {
      ...$.ui,
      open: async (pane) => localCalls.push(['open', pane]),
      close: async (pane) => localCalls.push(['close', pane]),
      log: async (message) => localCalls.push(['log', message]),
    },
  };
  register((event, matcher, hook) => localHooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), paths);
  const find = (event, predicate = () => true) => localHooks.find((hook) => hook.event === event && predicate(hook));
  await assert.doesNotReject(find('session.start').hook(local$, { cwd: worktree }, async () => ({ started: true })));
  await assert.doesNotReject(find('command.run').hook(local$, { command: 'wir' }, async () => ({})));
  assert(localCalls.some(([kind]) => kind === 'open'));
  const pane = find('ui.render', (hook) => hook.matcher?.component === 'Pane');
  const tree = await pane.hook(local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  findButton(tree, 'Close').props.onPress();
  await new Promise((resolve) => setImmediate(resolve));
  assert(localCalls.some(([kind]) => kind === 'close'));
  assert(!localCalls.some(([kind]) => kind === 'log'));
});
await test('an unremembered host pane does not adopt itself after restart', async () => {
  const restoredHooks = [];
  const restoredTimers = [];
  const restored$ = { ...$, store: { get: async () => false, set: async () => {} }, clock: { every: (ms, fn) => { const timer = { ms, fn, cancelled: false, cancel: () => { timer.cancelled = true; } }; restoredTimers.push(timer); return timer; } } };
  register((event, matcher, hook) => restoredHooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), paths);
  const find = (event, predicate = () => true) => restoredHooks.find((hook) => hook.event === event && predicate(hook));
  await find('session.start').hook(restored$, { cwd: worktree }, async () => ({}));
  const pane = find('ui.render', (hook) => hook.matcher?.component === 'Pane');
  const first = await pane.hook(restored$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({ downstream: true }));
  assert.deepEqual(first, { downstream: true });
  assert.equal(restoredTimers.length, 0);
});
await test('[toggle race] a detail state transition survives an overlapping slow snapshot refresh', async () => {
  const localHooks = []; const localCalls = []; const localTimers = [];
  const snapshot = { discovery: 'available', rows: [], sessions: [], services: { count: 1, items: [{ id: 'service:race', label: 'Race service' }] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now };
  let processCalls = 0; let releasePoll;
  const local$ = {
    ...$,
    process: { run: async () => {
      processCalls += 1;
      if (processCalls === 1) return { exitCode: 0, stdout: JSON.stringify(snapshot), stderr: '' };
      return new Promise((resolve) => { releasePoll = () => resolve({ exitCode: 0, stdout: JSON.stringify(snapshot), stderr: '' }); });
    } },
    clock: { every: (ms, fn) => { const timer = { ms, fn, cancelled: false, cancel: () => { timer.cancelled = true; } }; localTimers.push(timer); return timer; } },
    ui: { ...$.ui, invalidate: (event) => localCalls.push(['invalidate', event]) },
  };
  register((event, matcher, hook) => localHooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), paths);
  const find = (event, predicate = () => true) => localHooks.find((hook) => hook.event === event && predicate(hook));
  await find('session.start').hook(local$, { cwd: worktree }, async () => ({}));
  await find('command.run').hook(local$, { command: 'wir' }, async () => ({}));
  const pane = find('ui.render', (hook) => hook.matcher?.component === 'Pane');
  let tree = await pane.hook(local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({ downstream: true }));
  const poll = localTimers[0].fn();
  findButton(tree, 'Services (1)').props.onPress();
  await localTimers[0].fn();
  assert.equal(localTimers[0].cancelled, false);
  releasePoll();
  await poll;
  tree = await pane.hook(local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({ downstream: true }));
  assert.notDeepEqual(tree, { downstream: true });
  assert(findButton(tree, 'Close'));
  assert.match(JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value), /Race service/);
});
await test('an empty snapshot says nothing runs in the background', async () => {
  const originalRun = processCapability.run;
  try {
    processCapability.run = async () => ({ exitCode: 0, stdout: JSON.stringify({ discovery: 'available', rows: [], collectedAt: paths.now }), stderr: '' });
    await forwarded(hookFor('command.run'), { command: 'wir' });
    const pane = hookFor('ui.render', (hook) => hook.matcher?.component === 'Pane');
    const empty = await forwarded(pane, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' });
    assert.match(JSON.stringify(empty.result, (_key, value) => typeof value === 'function' ? '[function]' : value), /Nothing running in the background\./);
  } finally {
    processCapability.run = originalRun;
  }
});

await test('[Step 6 DoD 1] every Button has a visible bracket affordance without relying on colour', async () => {
  const snapshot = { discovery: 'available', rows: [], sessions: [{
    id: 'session:buttons', launcher: 'launched by: fixture', cards: [{
      id: '1862698281071544170', cardUrl: null, title: 'Buttons', actors: [{
        id: 'pilot:buttons', kind: 'pilot', label: 'Pilot', title: 'Buttons', phase: 'plan', outcome: 'running',
        phaseStates: { discovery: 'done', plan: 'running' }, inspectors: {}, lanes: [], gates: {}, review: {}, sources: {},
      }],
    }], actors: [],
  }], services: { count: 1, items: [{ id: 'service:button', label: 'Service', age: '1 min' }] }, helpers: { count: 1, oldest: '1 min', items: [{ id: 'helper:button', label: 'Helper', age: '1 min' }] }, collectedAt: paths.now };
  const { tree } = await renderSnapshot(snapshot);
  const buttons = descendants(tree, (item) => item.name === 'Button');
  assert(buttons.length >= 3);
  for (const button of buttons) {
    const children = [button.props.children].flat(2);
    assert(children.every((child) => typeof child === 'string'), String(button.props.key));
    assert(children.join('').startsWith('[') && children.join('').endsWith(']'), `${button.props.key}: ${children.join('')}`);
  }
});

await test('[changed Step 7 plain card ID][Step 6 DoD 2] card header is bold Text and its only URL is an open-card detail Link', async () => {
  const id = '1862698281071544171';
  const href = `https://boards.example.test/cards/${id}`;
  const { tree } = await renderSnapshot({ discovery: 'available', rows: [], sessions: [{
    id: 'session:link', launcher: 'launched by: fixture', cards: [{ id, cardUrl: href, title: 'Linked card', actors: [] }], actors: [],
  }], services: { count: 0, items: [] }, helpers: { count: 0, items: [] }, collectedAt: paths.now });
  const links = descendants(tree, (item) => item.name === 'Link');
  assert.equal(links.length, 1);
  assert.equal(links[0].props.href, href);
  assert.equal(links[0].props.label, 'open card');
  assert(!Object.hasOwn(links[0].props, 'children'));
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes(id)));
});

await test('[Step 6 DoD 4] detached lanes use durable env session IDs and older lanes stay unknown', async () => {
  const isolated = join(root, 'durable-launcher');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  for (const [name, id, env] of [
    ['new-lane', '1862698281071544172', 'CLAUDE_CODE_SESSION_ID=d25e8b32-62b1-499f-b71d-f67608db644b\n'],
    ['old-lane', '1862698281071544173', null],
  ]) {
    const lane = join(isolatedPaths.suiteRoot, 'worktrees', name, '.lane');
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, 'brief.md'), `# Brief: card ${id}: ${name}\n`);
    writeFileSync(join(lane, 'run.log'), 'working\n');
    if (env) writeFileSync(join(lane, 'env.log'), env);
  }
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.equal(snapshot.sessions.find((session) => session.id === 'session:d25e8b32-62b1-499f-b71d-f67608db644b')?.launcher, 'launched by: d25e8b32');
  assert.equal(snapshot.sessions.find((session) => session.id === 'session:unknown')?.launcher, 'launched by: unknown');
});

await test('[regression] a session inside its project .claude tree resolves to that project, not to .claude', async () => {
  // Field case 2026-09-14 20:58: a session whose cwd was <root>/.claude showed "Scope: this project · .claude" and no data.
  for (const [cwd, root] of [
    ['/home/u/projects/wt-suite/.claude', '/home/u/projects/wt-suite'],
    ['/home/u/projects/wt-suite/.claude/worktrees/x', '/home/u/projects/wt-suite'],
    ['/home/u/projects/wt-suite', '/home/u/projects/wt-suite'],
    ['C:\\Users\\u\\proj\\.claude', 'C:\\Users\\u\\proj'],
  ]) assert.equal(hooksModule.projectRootOf(cwd), root, cwd);
});

await test('[regression] button backgrounds are dark and link backgrounds light, so their host-rendered text stays readable', async () => {
  // Field case 2026-09-14 21:33 (#2286): an open stage on whiteBright and a blue link on magenta were unreadable.
  const light = new Set(['white', 'whiteBright', 'yellow', 'yellowBright', 'cyanBright', 'greenBright', 'gray', 'grey']);
  const { tree } = await renderSnapshot({ discovery: 'available', rows: [], sessions: [],
    services: { count: 1, items: [{ id: 'service:1', label: 'Atrium broker', age: '1 min' }] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now });
  const boxes = descendants(tree, (item) => item.name === 'Box' && item.props.backgroundColor);
  assert(boxes.length > 0, 'coloured controls rendered');
  for (const box of boxes) {
    const hasLink = descendants(box, (item) => item.name === 'Link').length > 0;
    assert.equal(light.has(box.props.backgroundColor), hasLink, `${hasLink ? 'link' : 'button'} background ${box.props.backgroundColor}`);
  }
});

await test('[Step 6 DoD 5] Services and Idle helpers have exact dim explanations, on the label row, name printed once', async () => {
  const { tree } = await renderSnapshot({ discovery: 'available', rows: [], sessions: [],
    services: { count: 1, items: [{ id: 'service:1', label: 'Atrium broker', age: '1 min' }] },
    helpers: { count: 1, oldest: '2 min', items: [{ id: 'helper:2', label: 'Codex app-server', age: '2 min' }] }, collectedAt: paths.now });
  for (const [name, meaning] of [
    ['Services', '· long-lived servers (links, Atrium)'],
    ['Idle helpers', '· Codex servers left after Astra calls, safe to stop'],
  ]) {
    const lines = descendants(tree, (item) => item.name === 'Text' && item.props.children.includes(meaning));
    assert.equal(lines.length, 1, meaning);
    assert.equal(lines[0].props.dimColor, true);
    const rows = descendants(tree, (item) => item.name === 'Box' && item.props.flexDirection === 'row' && descendants(item, (child) => child === lines[0]).length > 0);
    assert(rows.some((row) => JSON.stringify(row).includes(name + ' (')), `${meaning} sits on the ${name} label row`);
    const mentions = descendants(tree, (item) => ['Text', 'Button'].includes(item.name) && item.props.children.map(String).join('').includes(name));
    assert.equal(mentions.length, 1, `${name} printed ${mentions.length} times`);
  }
});

await test('[Round 6 title precedence] card receipt then implementation brief outrank review actors', async () => {
  const isolated = join(root, 'card-title-precedence');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const makeProcess = (pid, ppid, args) => {
    mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true });
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), `Name:\tfixture\nPPid:\t${ppid}\n`);
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), args.join('\0') + '\0');
  };
  makeProcess(100, 1, ['claude']);

  const implementationId = '1862698281071544128';
  const review = join(isolatedPaths.suiteRoot, 'worktrees', 'a-review');
  const implementation = join(isolatedPaths.suiteRoot, 'worktrees', 'z-implementation');
  for (const [dir, heading] of [[review, 'Independent review heading'], [implementation, 'Implementation card title']]) {
    mkdirSync(join(dir, '.lane'), { recursive: true });
    writeFileSync(join(dir, '.lane', 'brief.md'), `# Brief: card ${implementationId}, step 6. ${heading}\n`);
    writeFileSync(join(dir, '.lane', 'run.log'), 'working\n');
  }
  makeProcess(110, 100, ['opencode', 'run', '--dir', review]);
  makeProcess(120, 100, ['opencode', 'run', '--dir', implementation]);

  const receiptId = '1862698281071544129';
  const sdk = join(isolatedPaths.suiteRoot, 'worktrees', 'sdk-receipt');
  const otherImplementation = join(isolatedPaths.suiteRoot, 'worktrees', 'sdk-implementation');
  mkdirSync(join(sdk, '.lane'), { recursive: true });
  writeFileSync(join(sdk, '.lane', 'route.json'), JSON.stringify({ cardId: receiptId, route: 'LITE' }));
  writeFileSync(join(sdk, '.lane', 'card.md'), `# card ${receiptId}: Planka receipt title\n`);
  writeFileSync(join(sdk, '.lane', 'runner-stdout.log'), 'lifecycle: accepted phase=tdd\n');
  mkdirSync(join(otherImplementation, '.lane'), { recursive: true });
  writeFileSync(join(otherImplementation, '.lane', 'brief.md'), `# Brief: card ${receiptId}, step 6. Implementation fallback title\n`);
  writeFileSync(join(otherImplementation, '.lane', 'run.log'), 'working\n');
  makeProcess(130, 100, ['opencode', 'run', '--dir', otherImplementation]);

  const cards = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions.flatMap((session) => session.cards);
  assert.equal(cards.find((card) => card.id === implementationId).title, 'Implementation card title');
  assert.equal(cards.find((card) => card.id === receiptId).title, 'Planka receipt title');
});

await test('[Round 2 card title source] an external implementation card receipt outranks its brief heading', async () => {
  const isolated = join(root, 'external-card-receipt');
  const cardId = '1862698281071544124';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'implementation', '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'brief.md'), `# Brief: card ${cardId}, step 7 — Noisy implementation brief heading\n`);
  writeFileSync(join(lane, 'card.md'), `# Actual card name\n\nCard id: ${cardId}\n`);
  writeFileSync(join(lane, 'run.log'), 'working\n');
  const card = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions.flatMap((session) => session.cards).find((item) => item.id === cardId);
  assert.equal(card.title, 'Actual card name');
});

await test('[Round 6 round counting] reviews pair with fixes and excess arbiter fixes stay fix-only', async () => {
  const isolated = join(root, 'review-fix-counting');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const makeCard = (name, id, reviews, fixes) => {
    const lane = join(isolatedPaths.suiteRoot, 'worktrees', name, '.lane');
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, 'brief.md'), `# Brief: card ${id}, step 6. ${name}\n`);
    writeFileSync(join(lane, 'run.log'), 'working\n');
    if (reviews) {
      writeFileSync(join(lane, 'review-sol.md'), 'Review decision: changes requested\n');
      writeFileSync(join(lane, 'refutation-astra.log'), 'Tally: confirmed\nEXIT=0\n');
    }
    for (let round = 1; round <= fixes; round += 1) writeFileSync(join(lane, `fix-brief-${round}.md`), `# Fix brief ${round} for card ${id}\n`);
  };
  const reviewedId = '1862698281071544126';
  const fixOnlyId = '1862698281071544127';
  makeCard('paired-cycle', reviewedId, true, 4);
  makeCard('fix-only', fixOnlyId, false, 3);
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const cards = snapshot.sessions.flatMap((session) => session.cards);
  const reviewed = cards.find((card) => card.id === reviewedId);
  const fixOnly = cards.find((card) => card.id === fixOnlyId);
  assert.equal(reviewed.devCycle.rounds, 1);
  assert.equal(reviewed.devCycle.fixRounds, 3);
  assert.equal(fixOnly.devCycle.rounds, 0);
  assert.equal(fixOnly.devCycle.fixRounds, 3);
  const { tree } = await renderSnapshot(snapshot);
  const text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(text, /review rounds: 1 · fix rounds: 3/);
  assert(!text.includes('review ↔ fix:'));
});

await test('[changed Round 6 review-counted rounds][Step 6 DoD 3] card cycle uses current lane review, refutation, decision, and fix evidence', async () => {
  const isolated = join(root, 'lane-dev-cycle');
  const cardId = '1862698281071544174';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'cycle', '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'brief.md'), `# Brief: card ${cardId}: Cycle fixture\n`);
  writeFileSync(join(lane, 'run.log'), 'working\n');
  writeFileSync(join(lane, 'report.md'), '## Verification\nselftest passed\n');
  writeFileSync(join(lane, 'arbiter-decision.md'), '# Arbiter decision\n\nDecision: changes requested\n');
  writeFileSync(join(lane, 'fix-brief-1.md'), `# Fix brief for card ${cardId}\n`);
  writeFileSync(join(lane, 'fix-brief-2.md'), `# Fix brief for card ${cardId}\n`);
  const archived = join(isolatedPaths.suiteRoot, 'reports', 'cycle-review');
  mkdirSync(archived, { recursive: true });
  writeFileSync(join(archived, 'brief.md'), `# Review bundle for card ${cardId}\n`);
  writeFileSync(join(archived, 'review-brief.md'), `Review card ${cardId}\n`);
  writeFileSync(join(archived, 'review.md'), [
    '# Sol review', '### A-1', '- **Severity:** blocking', '- **Claim:** First finding.',
    '### B-1', '- **Severity:** non-blocking', '- **Claim:** Second finding.', 'review decision: changes requested',
  ].join('\n') + '\n');
  writeFileSync(join(archived, 'refute-request.md'), `Refute review for card ${cardId}\n`);
  writeFileSync(join(archived, 'refutation.log'), '| A-1 | Confirmed |\n| B-1 | Refuted |\nDecision: confirmed\nEXIT=0\n');
  for (const name of ['review-brief.md', 'review.md', 'refute-request.md', 'refutation.log']) writeFileSync(join(lane, name), readFileSync(join(archived, name), 'utf8'));

  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const card = snapshot.sessions.flatMap((session) => session.cards).find((item) => item.id === cardId);
  assert.deepEqual(card.devCycle.stages.map((stage) => [stage.id, stage.state]), [
    ['implementation', 'done'], ['review', 'done'], ['refutation', 'done'], ['arbiter', 'done'], ['fix', 'running'], ['merge', 'unknown'],
  ]);
  assert.equal(card.devCycle.rounds, 1);
  assert.equal(card.devCycle.fixRounds, 1);
  assert.equal(card.devCycle.stages.find((stage) => stage.id === 'review').summary, 'findings: 2 · blocking: 1 · decision: changes requested');
  assert.equal(card.devCycle.stages.find((stage) => stage.id === 'fix').summary, '1 fix round was requested.');
  assert.match(card.devCycle.stages.find((stage) => stage.id === 'arbiter').summary, /decision: changes requested/);
  const rendered = await renderSnapshot(snapshot);
  let tree = rendered.tree;
  findButton(tree, 'Sol review').props.onPress();
  tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  const text = JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.match(text, /review rounds: 1 · fix rounds: 1/);
  assert.match(text, /findings: 2 · blocking: 1 · decision: changes requested/);
});

await test('[A-3] implementer arbiter prose without the decision artifact leaves arbitration not started', async () => {
  const isolated = join(root, 'arbiter-prose');
  const cardId = '1862698281071544168';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'implementation', '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'brief.md'), `# Brief: card ${cardId}, step 6. Implementation\n`);
  writeFileSync(join(lane, 'run.log'), 'working\n');
  writeFileSync(join(lane, 'report.md'), '## Arbiter fixes\nArbiter decision: changes requested\n');
  writeFileSync(join(lane, 'fix-brief-1.md'), `# Fix brief: card ${cardId}, step 6\n`);
  const card = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions.flatMap((session) => session.cards).find((item) => item.id === cardId);
  assert.equal(card.devCycle.stages.find((stage) => stage.id === 'arbiter').state, 'not started');
});

await test('[changed Step 7 unknown omission][changed Round 3 report-first phase evidence][Round 2 item 1] every lifecycle phase inspector uses its own authoritative disk evidence', async () => {
  const isolated = join(root, 'all-phase-evidence');
  const cardId = '1862698281071544175';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'phases', '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'FULL', reasons: ['fixture route'], models: { lane: 'terra' } }));
  writeFileSync(join(lane, 'runner-stdout.log'), 'route=FULL reasons=fixture route model=opus effective=opus\nlifecycle: accepted phase=verify\n');
  const artifacts = {
    'plan.md': '# Plan\n## ADR\n### Decision\nPLAN EVIDENCE\n',
    'critic-report.md': 'VERDICT: approved\nFINDINGS:\n- CRITIC EVIDENCE\n',
    'tdd-brief.md': '# TDD\nTDD BRIEF EVIDENCE\n',
    'tdd-run.log': 'RED TEST failed\nGREEN TEST passed\nEXIT=0\n',
    'tdd-report.md': '# TDD report\nred proof: RED TEST failed\ngreen: 3 tests passed\nfiles: hooks.js, hooks.selftest.mjs\nTDD REPORT EVIDENCE\n',
    'typecheck.log': 'TYPECHECK EVIDENCE\nEXIT=0\n',
    'lint.log': 'LINT EVIDENCE\nEXIT=2\n',
    'test.log': 'TEST EVIDENCE\nEXIT=0\n',
    'review-brief.md': '# Review\nREVIEW BRIEF EVIDENCE\n',
    'review-run.log': 'REVIEW RUN EVIDENCE\nEXIT=0\n',
    'review-report.md': 'VERDICT: clear\nFINDINGS:\n- REVIEW REPORT EVIDENCE\n',
    'refutation-brief.md': '# Refutation\nREFUTATION BRIEF EVIDENCE\n',
    'refutation-report.md': 'VERDICT: clear\nFINDINGS:\n- REFUTATION REPORT EVIDENCE\n',
    'harden-brief.md': '# Harden\nHARDEN BRIEF EVIDENCE\n',
    'harden-run.log': 'HARDEN RUN EVIDENCE\nEXIT=0\n',
    'harden-report.md': '# Harden report\nHARDEN REPORT EVIDENCE\n',
    'pilot-report.md': '# Pilot report\n## Implemented\nREPORT EVIDENCE\n## Verification\nSHOULD NOT LEAD\n## Remaining Risks\nRISK EVIDENCE\n',
  };
  for (const [name, content] of Object.entries(artifacts)) writeFileSync(join(lane, name), content);
  const row = (await readSnapshot({ process: processCapability }, isolatedPaths)).rows.find((item) => item.id === cardId);
  for (const phase of ['discovery', 'plan', 'critic', 'tdd', 'verify', 'review', 'refutation', 'harden', 'report']) {
    assert(row.inspectors[phase]?.summary, phase);
  }
  assert.match(row.inspectors.discovery.summary, /FULL.*fixture route/s);
  assert.match(row.inspectors.plan.summary, /PLAN EVIDENCE/);
  assert.match(row.inspectors.critic.summary, /CRITIC EVIDENCE/);
  assert.match(row.inspectors.tdd.summary, /^red proof: RED TEST failed.*green: 3 tests passed.*files: hooks\.js, hooks\.selftest\.mjs.*TDD REPORT EVIDENCE.*run: pass \(EXIT=0\)/s);
  assert(!row.inspectors.tdd.summary.includes('TDD BRIEF EVIDENCE'));
  assert.match(row.inspectors.verify.summary, /typecheck: pass.*lint: fail \(2\).*test: pass/s);
  assert.match(row.inspectors.review.summary, /^verdict: clear\nfindings: 1\nREVIEW REPORT EVIDENCE\nbrief: Review/s);
  assert.match(row.inspectors.refutation.summary, /^verdict: clear\nfindings: 1\nREFUTATION REPORT EVIDENCE\nbrief: Refutation/s);
  assert.equal(row.inspectors.harden.summary, 'HARDEN REPORT EVIDENCE\nbrief: Harden');
  assert.match(row.inspectors.report.summary, /^Implemented\nREPORT EVIDENCE\nRemaining Risks\nRISK EVIDENCE$/);
  assert.equal(new Set(Object.values(row.inspectors).map((item) => item.summary)).size, 9);
});

await test('[Round 3 terminal runner] exited awaiting-fidelity runner is waiting and keeps its bounded report', async () => {
  const isolated = join(root, 'terminal-awaiting');
  const cardId = '1862698281071544153';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(isolatedPaths.procRoot, { recursive: true });
  const worktree = join(isolatedPaths.suiteRoot, 'worktrees', 'awaiting');
  const lane = join(worktree, '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'LITE' }));
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=report\nlifecycle: accepted phase=awaiting_fidelity\n');
  writeFileSync(join(lane, 'pilot-report.md'), '# Pilot report\n## Implemented\nTerminal work completed.\n## Verification\nAll green.\n## Remaining Risks\nArbiter fidelity remains.\n');
  mkdirSync(join(isolatedPaths.procRoot, '730'));
  writeFileSync(join(isolatedPaths.procRoot, '730', 'status'), 'Name:\topencode\nPPid:\t1\n');
  writeFileSync(join(isolatedPaths.procRoot, '730', 'cmdline'), ['opencode', 'run', '--dir', worktree, '--model', 'openai/gpt-5.6-sol'].join('\0') + '\0');
  const row = (await readSnapshot({ process: processCapability }, isolatedPaths)).rows.find((item) => item.id === cardId);
  assert.equal(row.outcome, 'waiting for arbiter review');
  assert.equal(row.phaseStates.awaiting_fidelity, 'waiting for arbiter review');
  assert.equal(row.inspectors.report.summary, 'Implemented\nTerminal work completed.\nRemaining Risks\nArbiter fidelity remains.');
});

await test('[Round 3 external review cycle] same-card review worktree drives running then done from process and report', async () => {
  const isolated = join(root, 'external-review-cycle');
  const cardId = '1862698281071544154';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const implementation = join(isolatedPaths.suiteRoot, 'worktrees', 'implementation');
  const review = join(isolatedPaths.suiteRoot, 'worktrees', 'review-outside');
  for (const [dir, title] of [[implementation, 'Implementation lane'], [review, 'Independent review']]) {
    mkdirSync(join(dir, '.lane'), { recursive: true });
    writeFileSync(join(dir, '.lane', 'brief.md'), `# Brief: card ${cardId}: ${title}\n`);
    writeFileSync(join(dir, '.lane', 'run.log'), 'working\n');
  }
  const makeProcess = (pid, ppid, args) => {
    mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true });
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), `PPid:\t${ppid}\n`);
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), args.join('\0') + '\0');
  };
  makeProcess(700, 1, ['claude']);
  makeProcess(710, 700, ['opencode', 'run', '--dir', implementation, '--model', 'openai/gpt-5.6-sol']);
  makeProcess(720, 700, ['opencode', 'run', '--dir', review, '--model', 'openai/gpt-5.6-sol']);
  const cardFrom = async () => (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions.flatMap((session) => session.cards).find((card) => card.id === cardId);
  let card = await cardFrom();
  assert.equal(card.devCycle.stages.find((stage) => stage.id === 'review').state, 'running');
  rmSync(join(isolatedPaths.procRoot, '720'), { recursive: true, force: true });
  writeFileSync(join(review, '.lane', 'run.log'), 'working\nEXIT=0\n');
  writeFileSync(join(review, '.lane', 'report.md'), 'VERDICT: approved\nFINDINGS:\n- One non-blocking note.\n');
  card = await cardFrom();
  assert.equal(card.devCycle.stages.find((stage) => stage.id === 'review').state, 'done');
  assert.match(card.devCycle.stages.find((stage) => stage.id === 'review').summary, /findings: 1.*decision: approved/);
});

await test('[Round 4 review freshness and model] finished reviews obey the active window and omit unknown models', async () => {
  const isolated = join(root, 'finished-review-freshness');
  const staleId = '1862698281071544156';
  const freshId = '1862698281071544157';
  const unknownId = '1862698281071544158';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', activeWindowMin: 10 };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  mkdirSync(isolatedPaths.procRoot, { recursive: true });
  const makeReview = (name, id, at, run) => {
    const lane = join(isolatedPaths.suiteRoot, 'worktrees', name, '.lane');
    mkdirSync(lane, { recursive: true });
    for (const [file, value] of [
      ['brief.md', `# Brief: card ${id}: Independent review\n`],
      ['run.log', run],
      ['report.md', 'VERDICT: approved\nFINDINGS:\n- Clear.\n'],
    ]) {
      const target = join(lane, file);
      writeFileSync(target, value);
      utimesSync(target, at, at);
    }
  };
  makeReview('stale-review', staleId, new Date('2026-09-12T12:00:00Z'), '> build · gpt-stale\nEXIT=0\n');
  makeReview('fresh-review', freshId, new Date('2026-09-12T12:25:00Z'), '> build · openai/gpt-5.6-sol\nEXIT=0\n');
  makeReview('unknown-review', unknownId, new Date('2026-09-12T12:25:00Z'), 'review complete\nEXIT=0\n');
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert(!snapshot.rows.some((row) => row.cardId === staleId), 'stale finished review is absent');
  const fresh = snapshot.rows.find((row) => row.cardId === freshId);
  assert.equal(fresh.model, 'openai/gpt-5.6-sol');
  const unknown = snapshot.rows.find((row) => row.cardId === unknownId);
  assert.equal(unknown.model, undefined);
  const rendered = await renderSnapshot(snapshot);
  const text = JSON.stringify(rendered.tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert(!text.includes('model unknown'));
});

await test('[A-1][A-2] stale review actor disappears while current-step receipts survive a same-worktree fix role', async () => {
  const isolated = join(root, 'durable-cycle-receipts');
  const cardId = '1862698281071544169';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', activeWindowMin: 10 };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const implementation = join(isolatedPaths.suiteRoot, 'worktrees', 'implementation');
  const review = join(isolatedPaths.suiteRoot, 'worktrees', 'detached-review');
  mkdirSync(join(implementation, '.lane'), { recursive: true });
  mkdirSync(join(review, '.lane'), { recursive: true });
  for (const [file, value] of [
    ['brief.md', `# Brief: card ${cardId}, step 6. Implementation\n`],
    ['run.log', 'implementation complete\nEXIT=0\n'],
    ['report.md', '## Implemented\nCurrent step complete.\n'],
    ['review-sol.md', '# Sol review\n### A-1\n- **Severity:** blocking\nReview decision: changes requested\n'],
    ['refutation-astra.log', '| A-1 | Confirmed |\nEXIT=0\n'],
    ['arbiter-decision.md', '# Arbiter decision\n\nDecision: changes requested\n'],
    ['fix-brief-1.md', `# Fix brief: card ${cardId}, step 6, review round 1\n`],
  ]) writeFileSync(join(implementation, '.lane', file), value);
  for (const [file, value] of [
    ['brief.md', `# Brief: card ${cardId}, step 6. Independent review\n`],
    ['run.log', 'review complete\nEXIT=0\n'],
    ['report.md', 'VERDICT: changes requested\nFINDINGS:\n- One finding.\n'],
  ]) {
    const target = join(review, '.lane', file);
    writeFileSync(target, value);
    utimesSync(target, new Date('2026-09-12T12:00:00Z'), new Date('2026-09-12T12:00:00Z'));
  }
  mkdirSync(join(isolatedPaths.procRoot, '940'), { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, '940', 'status'), 'Name:\topencode\nPPid:\t1\n');
  writeFileSync(join(isolatedPaths.procRoot, '940', 'cmdline'), ['opencode', 'run', `Read and execute ${join(implementation, '.lane', 'fix-brief-1.md')}`, '--dir', implementation, '--model', 'openai/gpt-5.6-sol'].join('\0') + '\0');
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const card = snapshot.sessions.flatMap((session) => session.cards).find((item) => item.id === cardId);
  assert(card, 'active fix keeps the card visible');
  assert(!snapshot.rows.some((row) => row.worktree === review), 'stale review actor is absent');
  assert(card.actors.some((actor) => actor.label === 'Fix lane'));
  assert.deepEqual(card.devCycle.stages.map((stage) => [stage.id, stage.state]), [
    ['implementation', 'done'], ['review', 'done'], ['refutation', 'done'], ['arbiter', 'done'], ['fix', 'running'], ['merge', 'unknown'],
  ]);
});

await test('[A-2] detached review-only activity retains completed current-step implementation', async () => {
  const isolated = join(root, 'detached-review-implementation');
  const cardId = '1862698281071544179';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const implementation = join(isolatedPaths.suiteRoot, 'worktrees', 'implementation');
  const review = join(isolatedPaths.suiteRoot, 'worktrees', 'review');
  for (const [dir, title] of [[implementation, 'Implementation'], [review, 'Independent review']]) {
    mkdirSync(join(dir, '.lane'), { recursive: true });
    writeFileSync(join(dir, '.lane', 'brief.md'), `# Brief: card ${cardId}, step 6. ${title}\n`);
    writeFileSync(join(dir, '.lane', 'run.log'), 'working\n');
  }
  writeFileSync(join(implementation, '.lane', 'report.md'), '## Implemented\nDone.\n');
  for (const file of ['brief.md', 'run.log', 'report.md']) utimesSync(join(implementation, '.lane', file), new Date('2026-09-12T12:00:00Z'), new Date('2026-09-12T12:00:00Z'));
  mkdirSync(join(isolatedPaths.procRoot, '950'), { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, '950', 'status'), 'Name:\topencode\nPPid:\t1\n');
  writeFileSync(join(isolatedPaths.procRoot, '950', 'cmdline'), ['opencode', 'run', '--dir', review, '--model', 'openai/gpt-5.6-sol'].join('\0') + '\0');
  const card = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions.flatMap((session) => session.cards).find((item) => item.id === cardId);
  assert(!card.actors.some((actor) => actor.worktree === implementation), 'stale implementation actor is absent');
  assert(card.actors.some((actor) => actor.label === 'Review lane'), 'detached review is the visible actor');
  assert.equal(card.devCycle.stages.find((stage) => stage.id === 'implementation').state, 'done');
});

await test('[Round 4 SDK implementation stage] same-card tdd and verify phases drive implementation', async () => {
  const isolated = join(root, 'sdk-implementation-stage');
  const cardId = '1862698281071544159';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'sdk', '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'LITE' }));
  const implementationState = async () => {
    const card = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions.flatMap((session) => session.cards).find((item) => item.id === cardId);
    return card.devCycle.stages.find((stage) => stage.id === 'implementation').state;
  };
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=tdd\n');
  assert.equal(await implementationState(), 'running');
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=tdd\nlifecycle: accepted phase=verify\n');
  assert.equal(await implementationState(), 'running');
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=tdd\nlifecycle: accepted phase=verify\nlifecycle: accepted phase=report\n');
  assert.equal(await implementationState(), 'done');
});

await test('[Round 4 nested fix lane] a live fix brief worker is labelled by role and round only', async () => {
  const isolated = join(root, 'nested-fix-role');
  const cardId = '1862698281071544162';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const worktree = join(isolatedPaths.suiteRoot, 'worktrees', 'sdk-with-fix');
  const lane = join(worktree, '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'LITE', model: 'opus' }));
  writeFileSync(join(lane, 'card.md'), `# card ${cardId}: Full repeated card title\n`);
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=awaiting_fidelity\n');
  const fixBrief = join(lane, 'fix-brief-2.md');
  writeFileSync(fixBrief, `# Fix brief: card ${cardId}, review round 2. Full repeated card title\n`);
  mkdirSync(join(isolatedPaths.procRoot, '910'), { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, '910', 'status'), 'Name:\topencode\nPPid:\t1\n');
  writeFileSync(join(isolatedPaths.procRoot, '910', 'cmdline'), ['opencode', 'run', `Read and execute the complete brief at ${fixBrief}.`, '--auto', '--dir', worktree, '--model', 'openai/gpt-5.6-sol'].join('\0') + '\0');
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const card = snapshot.sessions.flatMap((session) => session.cards).find((item) => item.id === cardId);
  const fix = card.actors.find((actor) => actor.kind === 'pilot').lanes[0];
  assert.equal(fix.label, 'Fix lane');
  assert.equal(fix.title, 'review round 2');
  assert.equal(card.devCycle.stages.find((stage) => stage.id === 'fix').state, 'running');
  const rendered = await renderSnapshot(snapshot);
  const text = JSON.stringify(rendered.tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert(!text.includes(`Fix lane · ${cardId}`));
  assert(!text.includes('Fix lane · Full repeated card title'));
});

await test('[Round 7 nested SDK lane] every same-card phase worker is labelled by phase without the card title', async () => {
  const isolated = join(root, 'nested-sdk-phase-role');
  const cardId = '1862698281071544126';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const worktree = join(isolatedPaths.suiteRoot, 'worktrees', 'sdk-tdd');
  const lane = join(worktree, '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'LITE', model: 'terra' }));
  writeFileSync(join(lane, 'card.md'), `# card ${cardId}: Full repeated card title\n`);
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=tdd\n');
  mkdirSync(join(isolatedPaths.procRoot, '920'), { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, '920', 'status'), 'Name:\tnode\nPPid:\t1\n');
  writeFileSync(join(isolatedPaths.procRoot, '920', 'cmdline'), ['node', '/plugin/bin/wt-lane.mjs', '--worker', '--dir', worktree, '--model', 'terra'].join('\0') + '\0');
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const card = snapshot.sessions.flatMap((session) => session.cards).find((item) => item.id === cardId);
  const nested = card.actors.find((actor) => actor.kind === 'pilot').lanes[0];
  assert.equal(nested.label, 'TDD lane');
  assert.equal(nested.title, null);
  const text = JSON.stringify((await renderSnapshot(snapshot)).tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert(!text.includes('TDD lane · Full repeated card title'));
});

await test('[changed Step 8 single bar][Round 3 shared state segments and card header] state words are spaced and titles never lead with a separator', async () => {
  const id = '1862698281071544155';
  const snapshot = { discovery: 'available', rows: [], sessions: [{ id: 'session:round3', launcher: 'Claude pid 1', cards: [{
    id, cardUrl: null, title: 'A card title long enough to wrap onto a continuation line without carrying a separator',
    devCycle: { stages: [{ id: 'implementation', label: 'Implementation lane', state: 'not started', summary: 'Not reached.' }], rounds: 0 },
    actors: [{ id: 'pilot:round3', kind: 'pilot', sdkLifecycle: true, label: 'SDK pilot', title: 'Pilot', phase: 'plan', outcome: 'running', phaseStates: { plan: 'running' }, inspectors: {}, lanes: [], gates: {}, review: {}, sources: {} }],
  }], actors: [] }], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now };
  const { tree } = await renderSnapshot(snapshot);
  const segment = descendants(tree, (item) => item.name === 'Box' && item.props.key === `stage-state:session:round3:${id}:plan`)[0];
  assert.equal(segment.props.columnGap, 1);
  assert.equal(descendants(tree, (item) => item.name === 'Text' && item.props.children.includes('Work stages:')).length, 1);
  const title = descendants(tree, (item) => item.name === 'Text' && item.props.children.includes(snapshot.sessions[0].cards[0].title))[0];
  assert(title, 'card title text');
  assert(!String(title.props.children[0]).startsWith('·'));
  const header = descendants(tree, (item) => item.name === 'Box' && item.props.flexDirection === 'row' && hasDescendant(item, (child) => child === title))[0];
  assert(header, 'card id and title share one wrapping row');
});

await test('[changed Step 8 content gating][Round 2 item 1] absent phase evidence cannot open meaningless details', async () => {
  const make = (id, phase, route, phaseStates) => ({
    id, kind: 'pilot', label: 'SDK pilot', title: id, phase, route, outcome: 'running', phaseStates,
    inspectors: {}, lanes: [], gates: {}, review: {}, sources: {},
  });
  const rows = [
    make('not-reached', 'plan', 'FULL', { discovery: 'done', plan: 'running', critic: 'not started' }),
    make('lite-skipped', 'tdd', 'LITE', { discovery: 'done', plan: 'skipped', tdd: 'running' }),
    make('running-empty', 'review', 'FULL', { review: 'running' }),
  ];
  for (const [id, label] of [['not-reached', 'Critic'], ['lite-skipped', 'Plan'], ['running-empty', 'Independent review']]) {
    const { tree } = await renderSnapshot({ discovery: 'available', rows: [rows.find((row) => row.id === id)], collectedAt: paths.now });
    assert(!findButton(tree, label), label);
    assert(hasDescendant(tree, (item) => item.name === 'Text' && !item.props.color && item.props.children.some((child) => String(child).includes(label))), label);
  }
});

await test('[Round 2 evidence rendering][safe markdown] phase evidence is clean, bounded Text without markdown execution', async () => {
  const summary = [
    '## Implemented',
    '- Added `safe-code` <script>literal</script>',
    '* pnpm typecheck: `EXIT=0`',
    '- third',
    '- fourth',
    '- fifth',
    '- sixth',
    '- seventh',
    '- eighth',
    '- ninth',
  ].join('\n');
  const row = { id: 'evidence-lines', kind: 'pilot', label: 'SDK pilot', title: 'Evidence', phase: 'plan', outcome: 'running', phaseStates: { plan: 'running' }, inspectors: { plan: { summary } }, lanes: [], gates: {}, review: {}, sources: {} };
  const tree = await renderProvidedSnapshot({ discovery: 'available', rows: [row], collectedAt: paths.now }, 'Plan');
  const detail = descendants(tree, (item) => item.name === 'Box' && item.props.key === 'open-detail-toggle:stage:evidence-lines:plan')[0];
  const lines = descendants(detail, (item) => item.name === 'Text').filter((item) => !item.props.children.includes('Plan'));
  assert(hasDescendant(detail, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes('Implemented')));
  assert(hasDescendant(detail, (item) => item.name === 'Text' && item.props.children.includes('Added safe-code <script>literal</script>')));
  assert(hasDescendant(detail, (item) => item.name === 'Text' && item.props.children.includes('pnpm typecheck: EXIT=0')));
  assert(hasDescendant(detail, (item) => item.name === 'Text' && item.props.children.includes('… 3 more lines')));
  assert.equal(lines.length, 8);
  assert.equal(descendants(detail, (item) => item.name === 'Link').length, 0);
  const visible = lines.flatMap((item) => item.props.children).join('\n');
  assert(!visible.includes('`'));
  assert(!visible.match(/^[-*]\s/m));
});

await test('[changed Step 8 open-state labels][Round 2 items 2-4] persistent controls and open phase details have non-colour affordances', async () => {
  const row = {
    id: 'affordance', kind: 'pilot', label: 'SDK pilot', title: 'Affordance', phase: 'plan', outcome: 'running',
    phaseStates: { discovery: 'done', plan: 'running' }, inspectors: { plan: { summary: 'Plan body' } }, lanes: [], gates: {}, review: {}, sources: {},
  };
  const rendered = await renderSnapshot({ discovery: 'available', rows: [row], services: { count: 3, items: [{ id: 's', label: 'Server' }] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now });
  let tree = rendered.tree;
  for (const label of ['[▶ SDK pilot]', '[▶ Services (3)]', '[Close]']) assert(findButton(tree, label), label);
  assert(findButton(tree, 'Services (3)'));
  findButton(tree, 'Plan').props.onPress();
  tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  assert(findButton(tree, '[Close]'));
  assert(findButton(tree, '▼ Plan'));
  const phaseBar = descendants(tree, (item) => item.name === 'Box' && item.props.flexWrap === 'wrap' && item.props.columnGap >= 1)
    .find((item) => hasDescendant(item, (child) => child.name === 'Button' && String(child.props.key).startsWith('detail-toggle:stage:')));
  assert(phaseBar, 'wrapping phase bar with a visible inter-segment gap');
});

await test('[Round 2 item 5] meaningful long rows wrap and fixed labels stay whole at 80 columns', async () => {
  const longTitle = 'A deliberately long card title whose final words must remain visible at eighty terminal columns';
  const row = { id: 'long-row', kind: 'pilot', label: 'SDK pilot', title: longTitle, phase: 'tdd', outcome: 'running', phaseStates: { discovery: 'done', tdd: 'running' }, inspectors: { tdd: { summary: 'A long inspector sentence that must wrap rather than disappear from the pane.' } }, lanes: [], gates: {}, review: {}, sources: {} };
  const tree = await renderProvidedSnapshot({ discovery: 'available', rows: [row], collectedAt: paths.now }, 'TDD');
  for (const text of [longTitle, row.inspectors.tdd.summary]) {
    assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.children.some((child) => String(child).includes(text)) && item.props.wrap === 'wrap'), text);
  }
  assert(!hasDescendant(tree, (item) => item.name === 'Text' && item.props.wrap === 'truncate-end' && item.props.children.some((child) => String(child).includes('long'))));
  assert(findButton(tree, 'SDK pilot'));
});

await test('[Round 2 items 7-8] SDK metadata is runner-derived and expanded rows hide internal diagnostics', async () => {
  const isolated = join(root, 'runner-metadata');
  const id = '1862698281071544176';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', clockTicks: 100 };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true }); mkdirSync(isolatedPaths.procRoot, { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, 'uptime'), '20000.00 1000.00\n');
  const worktree = join(isolatedPaths.suiteRoot, 'worktrees', 'metadata'); const lane = join(worktree, '.lane'); mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId: id, route: 'LITE', models: { lane: 'terra', review: 'sol', refutation: 'astra' } }));
  writeFileSync(join(lane, 'card.md'), `# card ${id}, step 6. Clean title after prefixes\n`);
  writeFileSync(join(lane, 'runner-stdout.log'), 'route=LITE model=opus effective=opus\nlifecycle: accepted phase=tdd\n');
  writeFileSync(join(lane, 'pid'), '910');
  mkdirSync(join(isolatedPaths.procRoot, '909')); writeFileSync(join(isolatedPaths.procRoot, '909', 'status'), 'PPid:\t1\n'); writeFileSync(join(isolatedPaths.procRoot, '909', 'cmdline'), ['node', '/plugin/bin/wt-pilot-runner.mjs', '--card', id, '--dir', worktree].join('\0') + '\0'); writeFileSync(join(isolatedPaths.procRoot, '909', 'stat'), `909 (runner) S 1 ${Array(17).fill('0').join(' ')} 1880000\n`);
  mkdirSync(join(isolatedPaths.procRoot, '910')); writeFileSync(join(isolatedPaths.procRoot, '910', 'status'), 'PPid:\t909\n'); writeFileSync(join(isolatedPaths.procRoot, '910', 'cmdline'), ['node', '/plugin/bin/wt-lane.mjs', '--worker', '--dir', worktree, '--model', 'terra'].join('\0') + '\0'); writeFileSync(join(isolatedPaths.procRoot, '910', 'stat'), `910 (runner) S 909 ${Array(17).fill('0').join(' ')} 1976000\n`);
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const actor = snapshot.rows.find((item) => item.id === id);
  assert.equal(actor.label, 'SDK pilot'); assert.equal(actor.model, 'opus'); assert.equal(actor.elapsed, '20 min'); assert.equal(actor.title, 'Clean title after prefixes'); assert.deepEqual(actor.models, { lane: 'terra', review: 'sol', refutation: 'astra' });
  const rendered = await renderSnapshot(snapshot); descendants(rendered.tree, (item) => item.name === 'Button').find((item) => item.props.key === `detail-toggle:row:${id}`).props.onPress();
  const expanded = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  const text = JSON.stringify(expanded, (_key, value) => typeof value === 'function' ? '[function]' : value);
  for (const forbidden of ['actors:', 'lifecycle:', 'spawnRegistry:', 'laneProbe:', 'gateLogs:']) assert(!text.includes(forbidden), forbidden);
});

await test('[Step 7 round 5 finding 2] awaiting-fidelity SDK pilot elapsed follows its live runner', async () => {
  const isolated = join(root, 'pilot-runner-elapsed');
  const id = '1862698281071544174';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux', clockTicks: 100 };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true }); mkdirSync(isolatedPaths.procRoot, { recursive: true });
  writeFileSync(join(isolatedPaths.procRoot, 'uptime'), '20000.00 1000.00\n');
  const worktree = join(isolatedPaths.suiteRoot, 'worktrees', 'elapsed'); const lane = join(worktree, '.lane'); mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId: id, route: 'FULL', model: 'opus' }));
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=tdd\nlifecycle: accepted phase=awaiting_fidelity\n');
  writeFileSync(join(lane, 'pid'), '921');
  for (const file of ['route.json', 'runner-stdout.log']) utimesSync(join(lane, file), new Date('2026-09-12T12:00:00Z'), new Date('2026-09-12T12:00:00Z'));
  utimesSync(join(lane, 'pid'), new Date('2026-09-12T12:26:00Z'), new Date('2026-09-12T12:26:00Z'));
  for (const [pid, ppid, args, startTicks] of [
    [920, 1, ['node', '/plugin/bin/wt-pilot-runner.mjs', '--card', id, '--dir', worktree], 1820000],
    [921, 920, ['node', '/plugin/bin/wt-lane.mjs', '--worker', '--dir', worktree, '--model', 'terra'], 1976000],
  ]) {
    mkdirSync(join(isolatedPaths.procRoot, String(pid)));
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), `PPid:\t${ppid}\n`);
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), args.join('\0') + '\0');
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'stat'), `${pid} (fixture) S ${ppid} ${Array(17).fill('0').join(' ')} ${startTicks}\n`);
  }
  let actor = (await readSnapshot({ process: processCapability }, isolatedPaths)).rows.find((item) => item.id === id);
  assert.equal(actor.phase, 'awaiting_fidelity');
  assert.equal(actor.elapsed, '30 min');
  assert.equal(actor.lanes[0].elapsed, '4 min');
  rmSync(join(isolatedPaths.procRoot, '920'), { recursive: true, force: true });
  actor = (await readSnapshot({ process: processCapability }, isolatedPaths)).rows.find((item) => item.id === id);
  assert.equal(actor.elapsed, '~30 min');
  assert.equal(actor.lanes[0].elapsed, '4 min');
});

await test('[Round 2 item 9] historical same-card reviews do not complete the current branch cycle', async () => {
  const isolated = join(root, 'current-cycle-only'); const id = '1862698281071544177';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'current', '.lane'); mkdirSync(lane, { recursive: true }); writeFileSync(join(lane, 'brief.md'), `# Brief: card ${id}, step 6. Current implementation\n`); writeFileSync(join(lane, 'run.log'), 'working\n');
  const oldLane = join(isolatedPaths.suiteRoot, 'worktrees', 'old-step', '.lane'); mkdirSync(oldLane, { recursive: true }); writeFileSync(join(oldLane, 'brief.md'), `# Brief: card ${id}, step 5. Earlier implementation\n`); writeFileSync(join(oldLane, 'report.md'), '## Implemented\nOld step.\n'); writeFileSync(join(oldLane, 'review-sol.md'), 'Review decision: approved\n'); writeFileSync(join(oldLane, 'arbiter-decision.md'), 'Decision: approved\n'); writeFileSync(join(oldLane, 'fix-brief-1.md'), `# Fix brief: card ${id}, step 5\n`);
  const old = join(isolatedPaths.suiteRoot, 'reports', 'old-step'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'brief.md'), `card ${id} step 5\n`); writeFileSync(join(old, 'review.md'), '### OLD-1\nreview decision: changes requested\n'); writeFileSync(join(old, 'fix-brief-7.md'), `card ${id}\n`);
  const card = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions.flatMap((session) => session.cards).find((item) => item.id === id);
  assert.equal(card.devCycle.rounds, 0);
  assert.equal(card.devCycle.stages.find((stage) => stage.id === 'review').state, 'not started');
  assert.equal(card.devCycle.stages.find((stage) => stage.id === 'merge').state, 'unknown');
});

await test('[merge false positive] an empty card branch behind main is not positive merge evidence', async () => {
  const isolated = join(root, 'equal-main'); const id = '1862698281071544178';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true }); mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true }); mkdirSync(isolatedPaths.livenessDir, { recursive: true }); mkdirSync(join(isolatedPaths.suiteRoot, 'worktrees'), { recursive: true });
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = (args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: isolatedPaths.suiteRoot, env: gitEnv, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'equal', '.lane'); mkdirSync(lane, { recursive: true }); writeFileSync(join(lane, 'brief.md'), `# Brief: card ${id}: Equal tip\n`); writeFileSync(join(lane, 'run.log'), 'working\n');
  git(['add', '.']); git(['commit', '-m', 'base']); git(['branch', `card/${id.slice(0, 10)}-equal`]);
  writeFileSync(join(isolatedPaths.suiteRoot, 'base-advanced.txt'), 'base advanced\n'); git(['add', '.']); git(['commit', '-m', 'advance base']);
  git(['checkout', `card/${id.slice(0, 10)}-equal`]);
  const card = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions.flatMap((session) => session.cards).find((item) => item.id === id);
  assert.equal(card.devCycle.stages.find((stage) => stage.id === 'merge').state, 'not started');
});

await test('[changed Step 8 single bar][Step 7 DoD 1-2] rendered hierarchy has keyed rules, blank card separators, one bar, and nested detail indentation', async () => {
  const sessionId = 'session:demarcation';
  const firstId = '1862698281071544100';
  const secondId = '1862698281071544101';
  const snapshot = { discovery: 'available', rows: [], sessions: [{ id: sessionId, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', project: 'fixture-project', name: 'Readable session', cards: [
    { id: firstId, cardUrl: `https://boards.example.test/cards/${firstId}`, title: 'First card', devCycle: { stages: [{ id: 'implementation', label: 'Implementation lane', state: 'running', summary: 'In progress.' }], rounds: 0, fixRounds: 0 }, actors: [{ id: 'pilot:demarcation', kind: 'pilot', label: 'SDK pilot', title: 'First card', phase: 'plan', outcome: 'running', phaseStates: { plan: 'running' }, inspectors: { plan: { summary: 'Plan detail' } }, lanes: [], gates: {}, review: {} }] },
    { id: secondId, cardUrl: null, title: 'Second card', actors: [] },
  ], actors: [] }], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now };
  const rendered = await renderSnapshot(snapshot);
  let tree = rendered.tree;
  findButton(tree, 'SDK pilot').props.onPress();
  tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  const session = descendants(tree, (item) => item.name === 'Box' && item.props.key === sessionId)[0];
  const sessionChildren = [session.props.children].flat(1).filter(Boolean);
  assert.equal(sessionChildren[0].props.key, `session-rule:${sessionId}`);
  assert.equal(sessionChildren[1].props.key, `session-header:${sessionId}`);
  assert(hasDescendant(sessionChildren[1], (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes('Session · fixture-project · Readable session')));
  const separator = descendants(session, (item) => item.name === 'Box' && item.props.key === `card-separator:${sessionId}:${secondId}`)[0];
  const separatorText = descendants(separator, (item) => item.name === 'Text').map((item) => item.props.children.join(''));
  assert.equal(separatorText[0], '');
  assert.match(separatorText[1], /^─+$/);
  const card = descendants(session, (item) => item.name === 'Box' && item.props.key === `card:${sessionId}:${firstId}`)[0];
  assert.equal(card.props.paddingLeft, 1);
  const pilot = descendants(card, (item) => item.name === 'Box' && item.props.key === 'pilot:pilot:demarcation')[0];
  assert.equal(pilot.props.paddingLeft, 1);
  assert(hasDescendant(pilot, (item) => item.name === 'Box' && item.props.key === 'open-detail-toggle:row:pilot:demarcation' && item.props.paddingLeft === 1));
  assert.equal(descendants(card, (item) => item.name === 'Text' && item.props.children.includes('Work stages:')).length, 1);
  assert(!hasDescendant(card, (item) => item.name === 'Text' && /Card cycle:|Pilot phases:/.test(item.props.children.join(''))));
});

await test('[Step 7 DoD 3] unknown values are omitted and an unidentified session renders only Session', async () => {
  const snapshot = { discovery: 'available', rows: [], sessions: [{ id: 'session:unknown', sessionId: null, project: null, name: null, cards: [{ id: '1862698281071544102', cardUrl: null, title: 'Known title', actors: [{ id: 'lane:unknown', kind: 'external', label: 'Lane', model: 'unknown', activity: 'unknown', elapsed: 'unknown' }] }], actors: [] }], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now };
  const rendered = await renderSnapshot(snapshot, null, true);
  findButton(rendered.tree, 'Show all projects').props.onPress();
  const tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  const visible = descendants(tree, (item) => item.name === 'Text').flatMap((item) => item.props.children).join(' ') + ' ' + descendants(tree, (item) => item.name === 'Link').map(linkText).join(' ');
  assert(!visible.includes('unknown'));
  const headers = descendants(tree, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes('Session'));
  assert.equal(headers.length, 1);
  assert.deepEqual(headers[0].props.children, ['Session']);
});

await test('[changed Round 2 duplicate title][Step 7 round 5 finding 3] custom-title reads are bounded and disclose no other transcript fields', async () => {
  const isolated = join(root, 'sdk-session-title');
  const projectRoot = join(isolated, 'named-project');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(projectRoot, '.claude'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const sessionId = '12345678-abcd-4321-abcd-123456789abc';
  const escapedId = '87654321-abcd-4321-abcd-123456789abc';
  const duplicateId = '11223344-abcd-4321-abcd-123456789abc';
  const boundedId = '22334455-abcd-4321-abcd-123456789abc';
  for (const [name, cardId, id] of [['sdk', '1862698281071544103', sessionId], ['escaped', '1862698281071544104', escapedId], ['duplicate', '1862698281071544107', duplicateId], ['bounded', '1862698281071544111', boundedId]]) {
    const lane = join(isolatedPaths.suiteRoot, 'worktrees', name, '.lane');
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId, route: 'LITE' }));
    writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=tdd\n');
    writeFileSync(join(lane, 'env.log'), `CLAUDE_CODE_SESSION_ID=${id}\n`);
  }
  const slug = projectRoot.replace(/[^A-Za-z0-9-]/g, '-');
  const transcriptDir = join(isolatedPaths.configDir, 'projects', slug);
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'custom-title', customTitle: 'Older title', sessionId }),
    'x'.repeat(300_000),
    JSON.stringify({ type: 'custom-title', customTitle: 'Latest title', sessionId, privateData: 'TRANSCRIPT_SECRET_MARKER' }),
  ].join('\n') + '\n');
  writeFileSync(join(transcriptDir, `${duplicateId}.jsonl`), JSON.stringify({ type: 'custom-title', customTitle: 'NAMED-PROJECT', sessionId: duplicateId }) + '\n');
  writeFileSync(join(transcriptDir, `${boundedId}.jsonl`), JSON.stringify({ type: 'custom-title', customTitle: 'TITLE_OUTSIDE_BOUNDED_TAIL', sessionId: boundedId }) + '\n' + 'x'.repeat(300_000) + '\n');
  const outside = join(isolated, 'outside-transcript.jsonl');
  writeFileSync(outside, JSON.stringify({ type: 'custom-title', customTitle: 'ESCAPED_TITLE', sessionId: escapedId }) + '\n');
  symlinkSync(outside, join(transcriptDir, `${escapedId}.jsonl`));
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const named = snapshot.sessions.find((session) => session.id === `session:${sessionId}`);
  assert.equal(named.project, 'named-project');
  assert.equal(named.name, 'Latest title');
  assert.equal(named.sessionId, sessionId);
  const escaped = snapshot.sessions.find((session) => session.id === `session:${escapedId}`);
  assert.equal(escaped.name, null);
  const bounded = snapshot.sessions.find((session) => session.id === `session:${boundedId}`);
  assert.equal(bounded.name, null);
  assert(!JSON.stringify(snapshot).includes('ESCAPED_TITLE'));
  assert(!JSON.stringify(snapshot).includes('TRANSCRIPT_SECRET_MARKER'));
  assert(!JSON.stringify(snapshot).includes('TITLE_OUTSIDE_BOUNDED_TAIL'));
  const { tree } = await renderSnapshot(snapshot);
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes('Session · named-project · Latest title')));
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes('Session · named-project · 87654321')));
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes('Session · named-project · 11223344')));
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes('Session · named-project · 22334455')));
  assert(!hasDescendant(tree, (item) => item.name === 'Text' && item.props.children.includes('Session · named-project · NAMED-PROJECT')));
  const renderedText = descendants(tree, (item) => item.name === 'Text').flatMap((item) => item.props.children).join(' ');
  assert(!renderedText.includes('TRANSCRIPT_SECRET_MARKER'));
});

await test('[Step 7 round 5 finding 4] every C0 control and DEL is replaced in a custom title', async () => {
  const isolated = join(root, 'controlled-session-title');
  const projectRoot = join(isolated, 'named-project');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(projectRoot, '.claude'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const sessionId = '33445566-abcd-4321-abcd-123456789abc';
  const lane = join(isolatedPaths.suiteRoot, 'worktrees', 'controls', '.lane');
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(lane, 'route.json'), JSON.stringify({ cardId: '1862698281071544112', route: 'LITE' }));
  writeFileSync(join(lane, 'runner-stdout.log'), 'lifecycle: accepted phase=tdd\n');
  writeFileSync(join(lane, 'env.log'), `CLAUDE_CODE_SESSION_ID=${sessionId}\n`);
  const transcriptDir = join(isolatedPaths.configDir, 'projects', projectRoot.replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(transcriptDir, { recursive: true });
  const allC0AndDel = Array.from({ length: 32 }, (_value, index) => String.fromCharCode(index)).join('') + String.fromCharCode(127);
  writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), JSON.stringify({ type: 'custom-title', customTitle: `Safe${allC0AndDel}title`, sessionId }) + '\n');
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  const session = snapshot.sessions.find((item) => item.id === `session:${sessionId}`);
  assert.equal(session.name, 'Safe title');
  assert.doesNotMatch(session.name, /[\x00-\x1f\x7f]/);
  const { tree } = await renderSnapshot(snapshot);
  const renderedText = descendants(tree, (item) => item.name === 'Text').flatMap((item) => item.props.children).join(' ');
  assert(renderedText.includes('Session · named-project · Safe title'));
  assert.doesNotMatch(renderedText, /[\x00-\x1f\x7f]/);
});

await test('[Round 2 activity] only recognised tool steps can replace the last-write fallback', async () => {
  const isolated = join(root, 'recognised-tool-activity');
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), now: paths.now };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  for (const [name, id, log] of [
    ['recognised', '1862698281071544108', '→ Read source.js\n→ expected value to equal another value // Object.is equality\n'],
    ['assertion-only', '1862698281071544109', '→ expected value to equal another value // Object.is equality\n'],
  ]) {
    const lane = join(isolatedPaths.suiteRoot, 'worktrees', name, '.lane');
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, 'brief.md'), `# Brief: card ${id}, step 7 — ${name}\n`);
    writeFileSync(join(lane, 'run.log'), log);
  }
  const snapshot = await readSnapshot({ process: processCapability }, isolatedPaths);
  assert.equal(snapshot.rows.find((row) => row.cardId === '1862698281071544108').activity, '→ Read source.js');
  assert.match(snapshot.rows.find((row) => row.cardId === '1862698281071544109').activity, /^last write \d+ min ago$/);
});

await test('[Step 7 DoD 5] card URLs occur only in open-card detail Links, never card header IDs', async () => {
  const id = '1862698281071544105';
  const href = `https://boards.example.test/cards/${id}`;
  const { tree } = await renderSnapshot({ discovery: 'available', rows: [], sessions: [{ id: 'session:card-link', project: 'project', sessionId: 'abcdefgh-1234', name: null, cards: [{ id, cardUrl: href, title: 'Linked', actors: [] }], actors: [] }], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now });
  const links = descendants(tree, (item) => item.name === 'Link');
  assert.equal(links.length, 1);
  assert.equal(links[0].props.label, 'open card');
  assert.equal(links[0].props.href, href);
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.bold === true && item.props.children.includes(id)));
});

await test('[changed Step 8 close rule][Step 7 DoD 6] every open row and stage detail keeps its toggle and has one working Close', async () => {
  const id = '1862698281071544106';
  const snapshot = { discovery: 'available', rows: [], sessions: [{ id: 'session:folds', project: 'project', sessionId: 'abcdefgh-1234', name: null, cards: [{ id, cardUrl: null, title: 'Folds', devCycle: { stages: [{ id: 'implementation', label: 'Implementation lane', state: 'running', summary: 'Cycle detail' }], rounds: 0, fixRounds: 0 }, actors: [{ id: 'pilot:folds', kind: 'pilot', sdkLifecycle: true, label: 'SDK pilot', title: 'Folds', phase: 'plan', outcome: 'running', phaseStates: { plan: 'running' }, inspectors: { plan: { summary: 'Phase detail' } }, lanes: [], gates: {}, review: {}, activity: 'active' }] }], actors: [] }], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now };
  const rendered = await renderSnapshot(snapshot);
  let tree = rendered.tree;
  for (const label of ['SDK pilot', 'Plan']) findButton(tree, label).props.onPress();
  tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  let openBlocks = descendants(tree, (item) => item.name === 'Box' && String(item.props.key || '').startsWith('open-detail-toggle:'));
  assert.equal(openBlocks.length, 2, 'one selected card stage plus one row detail');
  for (const block of openBlocks) {
    assert.equal(descendants(block, (item) => item.name === 'Button' && item.props.children.join('') === '[Close]').length, 1);
    assert(!findButton(block, 'Close view'));
  }
  findButton(openBlocks[0], '[Close]').props.onPress();
  tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  openBlocks = descendants(tree, (item) => item.name === 'Box' && String(item.props.key || '').startsWith('open-detail-toggle:'));
  assert.equal(openBlocks.length, 1);
});

await test('[Step 7 round 4] brackets occur only in Button text', async () => {
  const id = '1862698281071544110';
  const snapshot = {
    discovery: 'partial',
    pathRefusals: ['path [/outside/root] was refused'],
    rows: [],
    sessions: [{
      id: 'session:brackets', project: 'project [title]', sessionId: 'abcdefgh-1234', name: 'session [name]',
      cards: [{
        id, cardUrl: `https://boards.example.test/cards/${id}`, title: 'card [title]',
        devCycle: { stages: [{ id: 'implementation', label: 'Implementation [lane]', state: 'running', summary: 'cycle [evidence]' }], rounds: 0, fixRounds: 0 },
        actors: [{
          id: 'pilot:brackets', kind: 'pilot', label: 'SDK [pilot]', title: 'pilot [title]', phase: 'plan', outcome: 'error [message]',
          model: 'model [name]', activity: 'Read /tmp/[file] [offset=1]', elapsed: '1 [minute]', phaseStates: { plan: 'running' },
          inspectors: { plan: { summary: 'phase [evidence]', source: '/tmp/[artifact].md' } }, lanes: [{ id: 'lane:brackets', kind: 'external', label: 'Lane [label]', title: 'lane [title]', model: 'lane [model]', activity: 'Write [path]', elapsed: '2 [minutes]' }], gates: { test: '[failed]' }, review: { decision: '[changes]' }, watchdog: 'watch [message]',
        }],
      }],
      actors: [],
    }],
    services: { count: 1, items: [{ id: 'service:brackets', label: 'Service [name]', age: '3 [minutes]' }] },
    helpers: { count: 1, oldest: '4 [minutes]', items: [{ id: 'helper:brackets', label: 'Helper [name]', age: '4 [minutes]' }] },
    collectedAt: paths.now,
  };
  const rendered = await renderSnapshot(snapshot);
  let tree = rendered.tree;
  for (const label of ['SDK [pilot]', 'Plan', 'Implementation']) {
    const button = findButton(tree, label);
    if (button) button.props.onPress();
  }
  for (const button of descendants(tree, (item) => item.name === 'Button' && String(item.props.key).startsWith('detail-toggle:row:'))) if (!String(button.props.key).includes('pilot:')) button.props.onPress();
  tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  const textNodes = descendants(tree, (item) => item.name === 'Text');
  assert(textNodes.length > 0);
  for (const textNode of textNodes) {
    const text = textNode.props.children.map(String).join('');
    assert.doesNotMatch(text, /[\[\]]/, text);
  }
  assert(findButton(tree, '[Close]'));
  assert(!findButton(tree, '[Implementation ●]'));
  const links = descendants(tree, (item) => item.name === 'Link');
  assert.deepEqual(links.map(linkText), ['open card']);
});

const step8Fixture = () => {
  const id = '1862698281071544008';
  return { id, snapshot: {
    discovery: 'available', rows: [], sessions: [{ id: 'session:step8', project: 'project', sessionId: 'step8-session', name: null, cards: [{
      id, cardUrl: null, title: 'One interaction model',
      devCycle: { stages: [
        { id: 'implementation', label: 'Implementation lane', state: 'done', summary: 'SDK pilot TDD/verify: done' },
        { id: 'review', label: 'Sol review', state: 'done', summary: 'findings: 1 · decision: changes requested' },
        { id: 'refutation', label: 'Astra refutation', state: 'done', summary: 'finding confirmed' },
        { id: 'arbiter', label: 'Arbiter decision', state: 'done', summary: 'decision: changes requested' },
        { id: 'fix', label: 'Fix lane', state: 'running', summary: 'fix requested' },
        { id: 'merge', label: 'Merge', state: 'not started', summary: 'Not reached.' },
      ], rounds: 1, fixRounds: 0 },
      actors: [{
        id: 'pilot:step8', kind: 'pilot', sdkLifecycle: true, label: 'SDK pilot', title: 'One interaction model', phase: 'awaiting_fidelity', outcome: 'waiting for arbiter review', activity: 'active', models: { review: 'sol', refutation: 'astra' },
        phaseStates: { discovery: 'done', plan: 'skipped', critic: 'skipped', tdd: 'done', verify: 'done', review: 'skipped', refutation: 'skipped', harden: 'skipped', report: 'done', awaiting_fidelity: 'waiting for arbiter review' },
        inspectors: { discovery: { summary: 'Route selected.' }, tdd: { summary: Array.from({ length: 12 }, (_, index) => `evidence ${index + 1}`).join('\n'), href: 'https://artifacts.example.test/tdd.html', artifact: 'tdd-report.md' }, verify: { summary: 'All gates passed.' }, report: { summary: 'Implementation reported.' } },
        lanes: [], gates: { test: 'pass' }, review: {}, sources: {},
      }],
    }], actors: [] }], services: { count: 2, items: [{ id: 'service:1', label: 'Server one' }, { id: 'service:2', label: 'Server two' }] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now,
  } };
};

await test('[Step 8 rule 1] each card has one chronologically ordered, non-contradictory stage bar', async () => {
  const { snapshot } = step8Fixture();
  const { tree } = await renderSnapshot(snapshot);
  const visible = [];
  const collectVisible = (item) => {
    if (!item || typeof item !== 'object') return;
    if (item.name === 'Text' || item.name === 'Button') visible.push([item.props.children].flat(2).join(''));
    for (const child of [item.props?.children].flat(2)) collectVisible(child);
  };
  collectVisible(tree);
  const labels = visible.join(' ');
  assert.equal((labels.match(/Work stages:/g) || []).length, 1);
  assert(!labels.includes('Card cycle:'));
  assert(!labels.includes('Pilot phases:'));
  const ordered = ['Discovery', 'Plan', 'Critic', 'TDD', 'Verify', 'Independent review (sol)', 'Independent refutation (astra)', 'Harden', 'Report'];
  let previous = -1;
  for (const label of ordered) {
    const next = labels.indexOf(label);
    assert(next > previous, `${label}: ${labels}`);
    previous = next;
  }
  for (const legacy of ['Sol review', 'Astra refutation', 'Decision', 'Fix', 'Merge']) assert(!labels.includes(legacy), legacy);
  assert.equal((labels.match(/TDD/g) || []).length, 1, 'implementation must not duplicate the SDK TDD/verify state');
});

await test('[SDK lifecycle row] Report is last and legacy Merge is absent', async () => {
  const { snapshot } = step8Fixture();
  const pilot = snapshot.sessions[0].cards[0].actors[0];
  pilot.phase = 'verify';
  pilot.phaseStates.awaiting_fidelity = 'not started';
  const { tree } = await renderSnapshot(snapshot);
  const row = descendants(tree, (item) => item.name === 'Box' && item.props.flexWrap === 'wrap' && hasDescendant(item, (child) => child.name === 'Text' && child.props.children.includes('Work stages:')))[0];
  const labels = descendants(row, (item) => item.name === 'Text' || item.name === 'Button').flatMap((item) => [item.props.children].flat(2)).join(' ');
  assert(labels.includes('Report'));
  assert.equal(labels.includes('Merge'), false);
  assert.equal(descendants(tree, (item) => item.name === 'Text').flatMap((item) => item.props.children).join(' ').includes('review rounds:'), false);
  assert(labels.lastIndexOf('Report') > labels.lastIndexOf('Harden'));
});

await test('[legacy cycle row] legacy evidence remains the source when no SDK lifecycle exists', async () => {
  const { snapshot } = step8Fixture();
  const card = snapshot.sessions[0].cards[0];
  card.actors[0].sdkLifecycle = false;
  const { tree } = await renderSnapshot(snapshot);
  const text = descendants(tree, (item) => item.name === 'Text' || item.name === 'Button').flatMap((item) => [item.props.children].flat(2)).join(' ');
  assert(text.includes('Sol review'));
  assert(text.includes('Merge'));
  assert.equal(text.includes('Independent review'), false);
});

await test('[Step 8 rule 2] every detail toggle stays in place and toggles its own detail', async () => {
  const { snapshot } = step8Fixture();
  const rendered = await renderSnapshot(snapshot);
  const initial = descendants(rendered.tree, (item) => item.name === 'Button' && String(item.props.key || '').startsWith('detail-toggle:'));
  assert(initial.length >= 5);
  for (const button of initial) {
    button.props.onPress();
    let tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
    assert(descendants(tree, (item) => item.name === 'Button' && item.props.key === button.props.key).length === 1, `${button.props.key} disappeared`);
    assert(descendants(tree, (item) => item.name === 'Box' && item.props.key === `open-${button.props.key}`).length === 1, `${button.props.key} opened the wrong detail`);
    descendants(tree, (item) => item.name === 'Button' && item.props.key === button.props.key)[0].props.onPress();
    tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
    assert.equal(descendants(tree, (item) => item.name === 'Box' && item.props.key === `open-${button.props.key}`).length, 0, `${button.props.key} did not close itself`);
  }
});

await test('[Step 8 rule 2 close] every open detail has exactly one Close control and no arrow or Close view', async () => {
  const { snapshot } = step8Fixture();
  const rendered = await renderSnapshot(snapshot);
  for (const button of descendants(rendered.tree, (item) => item.name === 'Button' && String(item.props.key || '').startsWith('detail-toggle:'))) button.props.onPress();
  const tree = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  const details = descendants(tree, (item) => item.name === 'Box' && String(item.props.key || '').startsWith('open-detail-toggle:'));
  assert(details.length >= 3);
  for (const detail of details) {
    assert.equal(descendants(detail, (item) => item.name === 'Button' && item.props.children.join('') === '[Close]').length, 1, detail.props.key);
    assert.equal(descendants(detail, (item) => item.name === 'Button' && /▾|Close view/.test(item.props.children.join(''))).length, 0, detail.props.key);
  }
});

await test('[Step 8 rule 3] every lifecycle stage state is neutral text', async () => {
  const { snapshot } = step8Fixture();
  const { tree } = await renderSnapshot(snapshot);
  for (const label of ['Plan', 'Critic', 'Independent review', 'Independent refutation', 'Harden']) {
    assert(!findButton(tree, label), `${label} should not be clickable`);
    assert(hasDescendant(tree, (item) => item.name === 'Text' && !item.props.color && item.props.children.some((child) => String(child).includes(label))), `${label} should have neutral text`);
  }
  for (const text of descendants(tree, (item) => item.name === 'Text')) assert.doesNotMatch(text.props.children.map(String).join(''), /\[[^\]]+\]/);
});

await test('[regression] a detail body is bounded in characters, so long findings cannot push the rest of the view off screen', async () => {
  // Field case 2026-09-14: four ~600-character critic findings rendered as ~30 wrapped rows, and the SDK pilot row fell off screen.
  const finding = (n) => `[blocking] Finding ${n} ` + 'plan.md:183-198 lacks a discriminating test for platform handling and broker termination; '.repeat(7)
  const summary = ['VERDICT: changes-requested', finding(1), finding(2), finding(3), finding(4)].join('\n')
  const row = { id: 'long-findings', kind: 'pilot', label: 'SDK pilot', title: 'Findings', phase: 'critic', outcome: 'running', phaseStates: { plan: 'done', critic: 'running' }, inspectors: { critic: { summary } }, lanes: [], gates: {}, review: {}, sources: {} };
  const tree = await renderProvidedSnapshot({ discovery: 'available', rows: [row], collectedAt: paths.now }, 'Critic');
  const detail = descendants(tree, (item) => item.name === 'Box' && item.props.key === 'open-detail-toggle:stage:long-findings:critic')[0];
  assert(detail, 'Critic detail');
  const body = descendants(detail, (item) => item.name === 'Text' && item.props.wrap === 'wrap').map((item) => item.props.children.map(String).join(''));
  assert(body.length > 0, 'detail body lines');
  for (const line of body) assert(line.length <= 241, `evidence line of ${line.length} characters`);
  assert(body.join('').length <= 900, `detail body of ${body.join('').length} characters`);
});

await test('[Step 8 rules 4-5] artifact actions are real validated Links and detail bodies are bounded', async () => {
  const { snapshot } = step8Fixture();
  const tree = await renderProvidedSnapshot(snapshot, 'TDD');
  const detail = descendants(tree, (item) => item.name === 'Box' && item.props.key === 'open-detail-toggle:stage:session:step8:1862698281071544008:tdd')[0];
  assert(detail, 'TDD detail');
  const bodyLines = descendants(detail, (item) => item.name === 'Text').filter((item) => !item.props.bold).flatMap((item) => item.props.children);
  assert(bodyLines.length <= 8, `detail body has ${bodyLines.length} lines`);
  assert(bodyLines.some((line) => String(line).includes('… 5 more lines')));
  const report = descendants(detail, (item) => item.name === 'Link' && linkText(item) === '[Open report]');
  assert.equal(report.length, 1);
  assert.equal(hooksModule.isValidLinkHref(report[0].props.href), true);
  assert(!descendants(detail, (item) => item.name === 'Text').some((item) => /Open (?:full|first|report)/.test(item.props.children.join(''))));
});

await test('[Step 8 round 2 counters] one count line agrees with the Fix detail', async () => {
  const id = '1862698281071544009';
  const snapshot = { discovery: 'available', rows: [], sessions: [{ id: 'session:counts', cards: [{
    id, title: 'Consistent counts', actors: [], devCycle: { rounds: 1, fixRounds: 1, stages: [
      { id: 'fix', label: 'Fix lane', state: 'done', summary: '2 fix rounds were requested.' },
    ] },
  }], actors: [] }], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now };
  const tree = await renderProvidedSnapshot(snapshot, 'Fix');
  const text = descendants(tree, (item) => item.name === 'Text').flatMap((item) => item.props.children).join('\n');
  assert.match(text, /review rounds: 1 · fix rounds: 1/);
  assert.equal((text.match(/fix rounds:/g) || []).length, 1);
  assert(text.includes('1 fix round was requested.'));
  assert(!text.includes('2 fix rounds were requested.'));
  assert(!text.includes('review ↔ fix:'));
});

await test('[Step 8 round 2 details] empty labels and markdown markers are removed, and Open report is only a Link', async () => {
  const row = { id: 'detail-cleanup', kind: 'pilot', label: 'SDK pilot', title: 'Clean details', phase: 'discovery', outcome: 'running', phaseStates: { discovery: 'done' }, inspectors: {
    discovery: { summary: 'Reasons:\ndecision: **changes requested**\nresult: __fixed__\ncommand: `safe`', href: 'https://artifacts.example.test/discovery.html' },
  }, lanes: [], gates: {}, review: {}, sources: {} };
  const tree = await renderProvidedSnapshot({ discovery: 'available', rows: [row], collectedAt: paths.now }, 'Discovery');
  const detail = descendants(tree, (item) => item.name === 'Box' && item.props.key === 'open-detail-toggle:stage:detail-cleanup:discovery')[0];
  const textNodes = descendants(detail, (item) => item.name === 'Text');
  const text = textNodes.flatMap((item) => item.props.children).join('\n');
  assert(!text.includes('Reasons:'));
  assert(!/[`]|\*\*|__/.test(text));
  assert(text.includes('decision: changes requested'));
  assert.equal(descendants(detail, (item) => item.name === 'Link' && linkText(item) === '[Open report]').length, 1);
  assert(!textNodes.some((item) => item.props.children.join('').startsWith('Open ')));
});

await test('[increment role] structured lifecycle role outranks incidental review words and plain headings require an explicit role', async () => {
  const isolated = join(root, 'structured-lane-role');
  const cardId = '1862698281071544098';
  const isolatedPaths = { configDir: join(isolated, 'config'), livenessDir: join(isolated, 'liveness'), suiteRoot: join(isolated, 'suite'), procRoot: join(isolated, 'proc'), now: paths.now, platform: 'linux' };
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'store'), { recursive: true });
  mkdirSync(join(isolatedPaths.configDir, 'plugins', 'data'), { recursive: true });
  mkdirSync(isolatedPaths.livenessDir, { recursive: true });
  const implementation = join(isolatedPaths.suiteRoot, 'worktrees', 'implementation-review-title');
  const structured = join(isolatedPaths.suiteRoot, 'worktrees', 'structured-review');
  const explicit = join(isolatedPaths.suiteRoot, 'worktrees', 'explicit-review');
  for (const [dir, heading] of [[implementation, 'Lane supervision, review round 2'], [structured, 'Implementation wording'], [explicit, 'Review of release safety']]) {
    mkdirSync(join(dir, '.lane'), { recursive: true });
    writeFileSync(join(dir, '.lane', 'brief.md'), `# Brief: card ${cardId}: ${heading}\n`);
    writeFileSync(join(dir, '.lane', 'run.log'), 'working\n');
  }
  writeFileSync(join(structured, '.lane', 'sdk-pilot.log'), 'lifecycle: accepted phase=review\n');
  const makeProcess = (pid, dir) => {
    mkdirSync(join(isolatedPaths.procRoot, String(pid)), { recursive: true });
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'status'), 'Name:\topencode\nPPid:\t1\n');
    writeFileSync(join(isolatedPaths.procRoot, String(pid), 'cmdline'), ['opencode', 'run', '--dir', dir].join('\0') + '\0');
  };
  makeProcess(970, implementation); makeProcess(971, structured); makeProcess(972, explicit);
  const actors = (await readSnapshot({ process: processCapability }, isolatedPaths)).sessions.flatMap((session) => session.cards).flatMap((card) => card.actors);
  assert.equal(actors.find((actor) => actor.worktree === implementation).label, 'Lane');
  assert.equal(actors.find((actor) => actor.worktree === structured).label, 'Review lane');
  assert.equal(actors.find((actor) => actor.worktree === explicit).label, 'Review lane');
  assert.equal(actors.find((actor) => actor.worktree === explicit).roleInferred, true);
  const { tree } = await renderSnapshot({ discovery: 'available', rows: actors, collectedAt: paths.now });
  assert(hasDescendant(tree, (item) => item.name === 'Text' && item.props.children.includes('Review lane (inferred)')));
});

await test('[increment UI invariant] all rendered clickables are coloured and every detail toggle has the correct marker', async () => {
  const empty = await renderSnapshot({ discovery: 'available', rows: [], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now });
  assertClickableColourAndToggleMarkers(empty.tree);
  const { snapshot } = step8Fixture();
  const rendered = await renderSnapshot(snapshot);
  assertClickableColourAndToggleMarkers(rendered.tree);
  findButton(rendered.tree, 'TDD').props.onPress();
  let open = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  assertClickableColourAndToggleMarkers(open);
  findButton(open, 'Show all projects').props.onPress();
  open = await rendered.pane.hook(rendered.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  assertClickableColourAndToggleMarkers(open);
});

await test('[increment stage row] stages are visibly separated and no stage node carries a state colour', async () => {
  const { snapshot } = step8Fixture();
  snapshot.sessions[0].cards[0].actors[0].phaseCosts = {
    discovery: { input: 1234, output: 901, cacheRead: 2345678, cacheWrite: 5678, total: 2353491 },
    plan: 'unknown',
  };
  snapshot.sessions[0].cards[0].actors[0].phaseCostSource = '/fixture/archive/cost.json';
  const { tree } = await renderSnapshot(snapshot);
  const stageRow = descendants(tree, (item) => item.name === 'Box' && item.props.flexWrap === 'wrap' && hasDescendant(item, (child) => child.name === 'Text' && child.props.children.includes('Work stages:')))[0];
  const segments = descendants(stageRow, (item) => item.name === 'Box' && String(item.props.key || '').startsWith('stage-state:'));
  const separators = descendants(stageRow, (item) => item.name === 'Text' && item.props.children.join('') === '│');
  assert.equal(separators.length, segments.length - 1);
  for (const segment of segments) {
    for (const item of descendants(segment, () => true)) assert.equal(item.props?.color, undefined);
  }
  const costNodes = descendants(stageRow, (item) => String(item.props?.key || '').startsWith('phase-cost:'));
  for (const item of costNodes.flatMap((cost) => descendants(cost, () => true))) assert.equal(item.props?.color, undefined);
});

await test('[phase cost pane] wide rows show compact totals, narrow rows retain stage words, and details show four named counters plus source', async () => {
  const { snapshot } = step8Fixture();
  const pilot = snapshot.sessions[0].cards[0].actors[0];
  pilot.phaseCosts = {
    discovery: { input: 1234, output: 901, cacheRead: 2345678, cacheWrite: 5678, total: 2353491 },
    plan: 'unknown',
  };
  pilot.phaseCostSource = '/fixture/archive/cost.json';
  pilot.phaseCostSourceKind = 'archive cost.json';
  const narrow = await renderSnapshot(snapshot, null, false, 80);
  let text = descendants(narrow.tree, (item) => item.name === 'Text' || item.name === 'Button').flatMap((item) => [item.props.children].flat(2)).join(' ');
  for (const word of ['Discovery', 'Plan', 'Critic', 'TDD', 'Verify', 'Report']) assert(text.includes(word), word);
  assert(!text.includes('2 353 491 tokens'));

  const wide = await renderSnapshot(snapshot, null, false, 160);
  text = descendants(wide.tree, (item) => item.name === 'Text' || item.name === 'Button').flatMap((item) => [item.props.children].flat(2)).join(' ');
  assert(text.includes('2 353 491 tokens'));
  assert(text.includes('unknown'));
  findButton(wide.tree, 'Discovery').props.onPress();
  const open = await wide.pane.hook(wide.local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal', props: { bodyColumns: 160 } }, async () => ({}));
  const detail = descendants(open, (item) => item.name === 'Box' && item.props.key === 'open-detail-toggle:stage:session:step8:1862698281071544008:discovery')[0];
  const detailText = descendants(detail, (item) => item.name === 'Text').flatMap((item) => item.props.children).join(' ');
  assert(detailText.includes('cost so far | input: 1 234 | output: 901 | cache read: 2 345 678 | cache write: 5 678'));
  assert(detailText.includes('cost source: archive cost.json'));
});

await test('[Step 8 round 2 jitter] process refusals appear only after two consecutive pane polls', async () => {
  const localHooks = [];
  const localTimers = [];
  const snapshots = [
    { discovery: 'partial', pathRefusals: ['process live actor path was outside allowed roots'], rows: [], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now },
    { discovery: 'partial', pathRefusals: ['process live actor path was outside allowed roots'], rows: [], sessions: [], services: { count: 0, items: [] }, helpers: { count: 0, oldest: 'none', items: [] }, collectedAt: paths.now },
  ];
  const local$ = {
    ...$,
    process: { run: async () => ({ exitCode: 0, stdout: JSON.stringify(snapshots.shift() || snapshots.at(-1)), stderr: '' }) },
    store: { get: async () => false, set: async () => {} },
    clock: { every: (ms, fn) => { const timer = { ms, fn, cancel: () => {} }; localTimers.push(timer); return timer; } },
    ui: { ...$.ui },
  };
  register((event, matcher, hook) => localHooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), paths);
  const find = (event, predicate = () => true) => localHooks.find((hook) => hook.event === event && predicate(hook));
  await find('session.start').hook(local$, { cwd: worktree }, async () => ({}));
  await find('command.run').hook(local$, { command: 'wir' }, async () => ({}));
  const pane = find('ui.render', (hook) => hook.matcher?.component === 'Pane');
  let tree = await pane.hook(local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  let text = descendants(tree, (item) => item.name === 'Text').flatMap((item) => item.props.children).join('\n');
  assert(!text.includes('process live actor'));
  assert(!text.includes('discovery partial'));
  await localTimers.at(-1).fn();
  tree = await pane.hook(local$, { component: 'Pane', requestId: 'wt-what-is-running', surface: 'terminal' }, async () => ({}));
  text = descendants(tree, (item) => item.name === 'Text').flatMap((item) => item.props.children).join('\n');
  assert(text.includes('discovery partial (process live actor path was outside allowed roots)'));
});

rmSync(root, { recursive: true, force: true });
console.log(`tests: ${testCount - failures.length}/${testCount}`);
process.exitCode = failures.length ? 1 : 0;
