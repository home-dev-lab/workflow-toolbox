export interface TsHostSeams {
  platform: string
  arch: string
  env: Record<string, string | undefined>
  execPath: string
  home: string
  cwd: string
  isFile(file: string): boolean
  exists(file: string): boolean
  readText(file: string): string | undefined
  realpath(file: string): string | undefined
}

export type TsLaunchPlan =
  | { status: 'launch'; backend: 'typescript-language-server' | 'typescript-go'; command: string; args: string[] }
  | { status: 'refused'; message: string }

export interface TsInitializeParams {
  rootUri?: string
  rootPath?: string
  workspaceFolders?: Array<{ uri: string }>
  initializationOptions?: { tsserver?: { path?: string } }
}

export function planTsLaunch(params: TsInitializeParams, overrides?: Partial<TsHostSeams>): TsLaunchPlan
export function inspectInitialize(buffer: Buffer):
  | { status: 'pending' | 'exit' }
  | { status: 'notification'; consumed: number }
  | { status: 'refused'; message: string }
  | { status: 'initialize'; id?: string | number; params: TsInitializeParams }
export function runTsLaunch(options?: {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  exit?: (code: number) => void
  exitSignal?: (signal: NodeJS.Signals) => void
  select?: typeof planTsLaunch
  start?: typeof import('node:child_process').spawn
}): void
