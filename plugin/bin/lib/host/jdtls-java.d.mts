export interface JdtlsHostSeams {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  homeDirectory: string
  readText(file: string): string | undefined
  isFile(file: string): boolean
  listDirectory(directory: string): string[]
  run(command: string, args: string[]): { status: number | null; stdout?: string; stderr?: string }
}

export interface JdtlsJava {
  executable: string | undefined
  major: number | null
  source: string
}

export type JdtlsLaunchPlan =
  | { status: 'launch'; command: string; args: string[]; java: JdtlsJava }
  | { status: 'refused'; message: string }
  | { status: 'usage-error'; message: string }
  | { status: 'help'; text: string }

export function planJdtlsLaunch(argv: string[], overrides?: Partial<JdtlsHostSeams>): JdtlsLaunchPlan

export function runJdtlsLaunch(
  plan: JdtlsLaunchPlan,
  options?: { exit?: (code: number) => void; stderr?: { write(text: string, callback?: () => void): unknown } },
): void
