/** Default OS-level deadline for synchronous test hook children, in milliseconds. */
export * from 'node:child_process'
export { default } from 'node:child_process'
export const HOOK_SPAWN_TIMEOUT_MS: 30000
export const spawnSync: typeof import('node:child_process').spawnSync
export const execFileSync: typeof import('node:child_process').execFileSync
