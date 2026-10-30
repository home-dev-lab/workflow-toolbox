import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const admissionTestPlatform = process.env.WT_ADMISSION_TEST_PLATFORM ?? process.platform

export const refusingImportPolicy = `import { writeFileSync } from 'node:fs';
  writeFileSync(new URL('./policy-imported', import.meta.url), 'yes');
  export default () => 'policy refuses';`

export const admittingImportPolicy = refusingImportPolicy.replace("=> 'policy refuses'", '=> null')

// Re-export the real containment module and override only its host factory.
// Keep the native fork: this simulates the platform gate, not the filesystem or OS.
export function containmentHostOverride(platform: string) {
  return `if (url.endsWith('/admission-containment.mjs')) {
    const native = url + '?native';
    return { format: 'module', shortCircuit: true, source:
      'export * from ' + JSON.stringify(native) + '; import { admissionContainmentHost as nativeHost } from ' + JSON.stringify(native) +
      '; export const admissionContainmentHost = () => ({ ...nativeHost(), platform: ${JSON.stringify(platform)} });' };
  }`
}

// An omitted override really exercises the host, including on native macOS/Windows.
export function containmentLoader(root: string, platform = process.env.WT_ADMISSION_TEST_PLATFORM) {
  if (platform === undefined || platform === 'native') return []
  const loader = join(root, 'containment-loader.mjs')
  writeFileSync(loader, `export async function load(url, context, next) {
    ${containmentHostOverride(platform)}
    return next(url, context);
  }`)
  return ['--loader', pathToFileURL(loader).href]
}

export function platformRefusal(platform: string) {
  return `containment unknown (${platform}): admission policy was not started; a native descendant container is unavailable`
}

export function policyCause(cause: string) {
  return admissionTestPlatform === 'linux' ? cause : platformRefusal(admissionTestPlatform)
}
