import { createRequire } from 'node:module'
import { expect } from 'vitest'

// Reuse ESLint's installed Ajv dependency without adding a runtime dependency.
const require = createRequire(import.meta.url)
type Validator = ((value: unknown) => boolean) & { errors?: unknown }
const Ajv = createRequire(require.resolve('eslint'))('ajv') as new (options: object) => {
  compile(schema: object): Validator
}
const ajv = new Ajv({ allErrors: true })

export function assertSchema(value: unknown, schema: object, expectedValid = true): void {
  const validate = ajv.compile(schema)
  const valid = validate(value)
  expect(valid, JSON.stringify(validate.errors)).toBe(expectedValid)
}
