// The second-opinion CLI's native filesystem boundary: preserve Node's functions,
// descriptor semantics and thrown errors without adding policy or fallback behavior.
export { appendFileSync, closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
