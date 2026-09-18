import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const methods = ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'] as const

for (const method of methods) {
  const original = childProcess[method] as (...args: unknown[]) => unknown
  Object.assign(childProcess, {
    [method](...args: unknown[]) {
      const directory = process.env.NODE_V8_COVERAGE
      if (directory) {
        args = args.map((argument) => {
          if (!argument || Array.isArray(argument) || typeof argument !== 'object' || !Object.hasOwn(argument, 'env')) return argument
          const options = argument as { env?: NodeJS.ProcessEnv }
          return { ...options, env: { ...options.env, NODE_V8_COVERAGE: directory } }
        })
      }
      return Reflect.apply(original, this, args)
    },
  })
}

syncBuiltinESMExports()
