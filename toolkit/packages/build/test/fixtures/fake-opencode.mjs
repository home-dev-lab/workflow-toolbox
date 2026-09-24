import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const action = process.env.WT_FAKE_OPENCODE_ACTION || ''
const cwd = process.cwd()
const argv = process.argv.slice(2)
if (argv[0] === 'opencode') argv.shift()
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const write = (name, value = '') => writeFileSync(path.join(cwd, name), value)

function skills() {
  if (process.env.WT_IGNORE_FENCE === '1') return [{ name: 'workflow-toolbox-fence-sentinel' }]
  if (process.env.WT_INVISIBLE_ALLOW === '1') return []
  return [{ name: 'workflow-toolbox-allowed-sentinel' }]
}

async function runAction() {
  if (action.startsWith('observer:')) {
    const observer = JSON.parse(action.slice('observer:'.length))
    if (observer.capture) {
      const task = argv.find((value, index, values) => values[index - 1] === '-f')
      if (!task) throw new Error('fixture expected observer task argument')
      copyFileSync(task, observer.capture)
    }
    if (observer.calls) appendFileSync(observer.calls, 'call\n')
    if (observer.touch) writeFileSync(observer.touch, 'x')
    if (observer.finding) {
      process.stdout.write(`${JSON.stringify({ type: 'text', part: { text: JSON.stringify(observer.finding) } })}\n`)
      process.stdout.write(`${JSON.stringify({ type: 'step_finish', part: { tokens: { input: 100, output: 20, reasoning: 5, total: 125, cache: { read: 80, write: 10 } } } })}\n`)
    } else process.stdout.write('{"status":"clean"}\n')
    return
  }
  if (action === 'true') return
  if (action === 'sleep 0.2' || action === 'sleep 0.5') return sleep(Number(action.slice(6)) * 1000)
  if (action === 'sleep 1') return sleep(1000)
  if (action.includes('echo $$ > "$PWD/first.pid"; sleep 30')) {
    if (!existsSync(path.join(cwd, 'progress'))) {
      write('progress', 'kept')
      write('first.pid', `${process.pid}\n`)
      return sleep(30_000)
    }
    await sleep(500)
    write('resumed', 'resumed')
    return
  }
  if (action.includes('cp "$brief" "$PWD/obeyed.md"')) {
    const brief = argv.find((value) => value.startsWith('Read and execute the complete brief at '))
    if (!brief) throw new Error('fixture expected lane brief argument')
    copyFileSync(brief.slice('Read and execute the complete brief at '.length).replace(/\.$/, ''), path.join(cwd, 'obeyed.md'))
    return
  }
  if (action.includes('OPENCODE_DISABLE_CLAUDE_CODE_SKILLS')) {
    write('claude-skills-fence', `${process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS || ''}\n`)
    write('argv', `${argv.join('\n')}\n`)
    return
  }
  if (action.includes('printf "%s\\n" "$@" > "$PWD/argv"')) {
    write('argv', `${argv.join('\n')}\n`)
    return
  }
  if (action.includes('IDENTITY_RECORD')) {
    if (process.env.WT_IDENTITY_RECORD) appendFileSync(process.env.WT_IDENTITY_RECORD, `run|${cwd}|${process.env.WT_IDENTITY_MARKER || ''}|${process.env.OPENCODE_CONFIG || 'unset'}\n`)
    write('spawned', 'spawned')
    return
  }
  if (action.includes('opencode-config')) {
    write('opencode-config', process.env.OPENCODE_CONFIG || '')
    return
  }
  if (action.includes('run.log')) {
    appendFileSync(path.join(cwd, '.lane', 'run.log'), 'lane done\nEXIT=0\n')
    write('opencode.pid', `${process.pid}\n`)
    return sleep(30_000)
  }
  if (action.includes('echo $$ > "$PWD/opencode.pid"; sleep 30')) {
    write('opencode.pid', `${process.pid}\n`)
    return sleep(30_000)
  }
  if (action.includes('echo $$ > "$PWD/opencode.pid"; sleep 120')) {
    write('opencode.pid', `${process.pid}\n`)
    return sleep(120_000)
  }
  if (action.includes('IFS= read -r x')) {
    await sleep(200)
    process.stdout.write('done\n')
    return
  }
  if (action.includes('printf spawned > "$PWD/spawned"') || action.includes('echo spawned > "$PWD/spawned"')) {
    write('spawned', 'spawned')
    return
  }
  throw new Error(`unrecognised portable fake action: ${action}`)
}

if (argv[0] === '--version') process.stdout.write('fixture-1\n')
else if (argv[0] === '--pure') process.stdout.write(`${JSON.stringify(skills())}\n`)
else if (argv[0] === 'debug' && argv[1] === 'skill') {
  if (process.env.WT_IDENTITY_RECORD) appendFileSync(process.env.WT_IDENTITY_RECORD, `probe|${cwd}|${process.env.WT_IDENTITY_MARKER || ''}|${process.env.OPENCODE_CONFIG || 'unset'}\n`)
  const countFile = path.join(cwd, '.lane', 'preflight-count')
  const count = (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0) + 1
  if (process.env.WT_SLOW_PREFLIGHT_AT_COUNT || process.env.WT_FAIL_PREFLIGHT_AT_COUNT) writeFileSync(countFile, String(count))
  if (String(count) === process.env.WT_SLOW_PREFLIGHT_AT_COUNT) await sleep(6000)
  if (String(count) === process.env.WT_FAIL_PREFLIGHT_AT_COUNT) process.exitCode = 7
  else process.stdout.write(`${process.env.WT_EFFECTIVE_SKILLS || '[]'}\n`)
} else await runAction()
