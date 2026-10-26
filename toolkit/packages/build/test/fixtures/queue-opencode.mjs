import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
if (argv.includes('--version')) process.stdout.write('fixture-1\n')
else if (argv.includes('--pure')) process.stdout.write('[{"name":"workflow-toolbox-allowed-sentinel"}]\n')
else if (argv[0] === 'debug') process.stdout.write('[]\n')
else if (process.cwd().endsWith('idle')) setInterval(() => {}, 1000)
else {
  const cli = fileURLToPath(new URL('../../../../../plugin/bin/wt-suite-lock.mjs', import.meta.url))
  const child = spawn(process.execPath, [cli, 'run', '--wait-s', '60', '--', process.execPath, '-e', 'console.log("gate ran")'], { stdio: 'inherit' })
  child.on('error', () => { process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
}
