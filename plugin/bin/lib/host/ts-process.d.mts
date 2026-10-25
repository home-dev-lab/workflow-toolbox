import type { SpawnOptions } from 'node:child_process'
export function tsProcessOptions(options: SpawnOptions): SpawnOptions & { env: NodeJS.ProcessEnv }
export const spawnTsProcess: typeof import('node:child_process').spawn
