// prove-discriminates.ts — a mutation-based red-proof is only evidence if the mutated run and
// the unmutated (baseline) run produce DIFFERENT output. This helper runs both, compares their
// outputs, and throws if they are identical — closing the failure mode where a test's own
// parameters make both branches unreachable in the same way, so "the assertion stayed green"
// looks like a passing mutation lock when it never discriminated anything.
//
// HONEST SCOPE: this only covers mutations run THROUGH this helper — i.e. a test that calls
// proveMutationDiscriminates() to produce and compare its baseline/mutated outputs. A hand-run
// red-proof (revert the fix, run the suite, eyeball the diff) that never calls this function
// stays entirely outside what it can check; adopting this helper is opt-in per test, and
// nothing here detects or flags a mutation test written without it.

function describeForMessage(output: unknown): string {
  try {
    const stringified = JSON.stringify(output)
    // JSON.stringify returns the JS value `undefined` (not the string "undefined") for
    // top-level undefined/function/Symbol inputs, despite its lib typing claiming `string`.
    // Fall through to String() for those so the message is never a silently-wrong render.
    return typeof stringified === 'string' ? stringified : String(output)
  } catch {
    try {
      return String(output)
    } catch {
      // A value whose own toString() throws (rare, but possible on a hostile/broken
      // object) must not crash the error we are constructing to REPORT a failure.
      return '<unrepresentable output>'
    }
  }
}

export class MutationDoesNotDiscriminateError extends Error {
  constructor(label: string | undefined, output: unknown) {
    const context = label ? ` (${label})` : ''
    super(
      `Mutation proof does not discriminate${context}: the baseline run and the mutated run ` +
        `produced IDENTICAL output. This test locks nothing — it never proves the mutation was ` +
        `caught, because a passing AND a failing subject look the same to it. Widen the test's ` +
        `own window/parameters so the two runs actually differ. Shared output: ` +
        `${describeForMessage(output)}`,
    )
    this.name = 'MutationDoesNotDiscriminateError'
  }
}

export interface ProveMutationDiscriminatesArgs<T> {
  /** Produces output from the subject in its correct, unmutated state. */
  baseline: () => T | Promise<T>
  /** Produces output from the subject AFTER the mutation under test has been applied. */
  mutated: () => T | Promise<T>
  /**
   * Compares two outputs for equality. Defaults to a structural, key-order-independent deep
   * equality check (see `structurallyEqual` below) — correct for plain objects/arrays,
   * primitives (including NaN, via Object.is), BigInt, Date, Map, and Set.
   *
   * Known limits of the default, disclosed rather than hidden:
   *  - Functions and Symbols compare by reference only (two functions with identical bodies
   *    but different identity are "different" — this is the ordinary JS notion of identity).
   *  - Two circular/self-referential structures that are NOT the same object reference are not
   *    cycle-safe: the comparison degrades to reference equality (`===`) rather than crashing,
   *    which almost always reports them as "different" even if their content is equivalent.
   *    Only the same-reference case (baseline and mutated returning the identical object) is
   *    guaranteed correct.
   *  - Only own enumerable string keys are compared; Symbol-keyed properties, non-enumerable
   *    properties, and prototype chain are ignored.
   * Callers whose outputs hit any of these must pass their own `isEqual`.
   */
  isEqual?: (a: T, b: T) => boolean
  /** Optional label included in the failure message and error, to identify which proof failed. */
  label?: string
}

export interface ProveMutationDiscriminatesResult<T> {
  baselineOutput: T
  mutatedOutput: T
}

/**
 * Runs `baseline()` then `mutated()`, compares their outputs, and throws
 * MutationDoesNotDiscriminateError if they are equal (the proof does not discriminate).
 * On success (outputs differ), resolves with both outputs so the caller can assert on them
 * further if it wants to.
 */
export async function proveMutationDiscriminates<T>(
  args: ProveMutationDiscriminatesArgs<T>,
): Promise<ProveMutationDiscriminatesResult<T>> {
  const baselineOutput = await args.baseline()
  const mutatedOutput = await args.mutated()
  const isEqual = args.isEqual ?? defaultIsEqual
  if (isEqual(baselineOutput, mutatedOutput)) {
    throw new MutationDoesNotDiscriminateError(args.label, baselineOutput)
  }
  return { baselineOutput, mutatedOutput }
}

function defaultIsEqual<T>(a: T, b: T): boolean {
  try {
    return structurallyEqual(a, b)
  } catch {
    // Deep recursion on a non-same-reference circular/self-referential structure can overflow
    // the call stack. Degrade to reference equality rather than crashing the proof itself —
    // see the isEqual doc above for the honest limit this implies.
    return a === b
  }
}

// Structural, key-order-independent deep equality. Replaces a naive JSON.stringify comparison,
// which has two dangerous failure directions for THIS helper's job specifically: it reports
// distinct values (e.g. NaN and Infinity, or two different Maps) as "identical" (a false
// non-discrimination that blocks a valid test loudly), and — more dangerously for a mutation
// proof — it reports semantically-identical objects with differently-ordered keys as
// "different" (a false discrimination that could let a hollow mutation report a clean pass,
// exactly the failure class this whole helper exists to catch).
function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false // primitives (incl. NaN, BigInt) already settled above

  const aObj = a as object
  const bObj = b as object

  const aIsArray = Array.isArray(aObj)
  const bIsArray = Array.isArray(bObj)
  if (aIsArray !== bIsArray) return false
  if (aIsArray && bIsArray) {
    const aArr = aObj as unknown[]
    const bArr = bObj as unknown[]
    if (aArr.length !== bArr.length) return false
    return aArr.every((item, i) => structurallyEqual(item, bArr[i]))
  }

  if (aObj instanceof Date && bObj instanceof Date) {
    return aObj.getTime() === bObj.getTime()
  }

  if (aObj instanceof Map && bObj instanceof Map) {
    if (aObj.size !== bObj.size) return false
    for (const [key, value] of aObj) {
      if (!bObj.has(key) || !structurallyEqual(value, bObj.get(key))) return false
    }
    return true
  }

  if (aObj instanceof Set && bObj instanceof Set) {
    if (aObj.size !== bObj.size) return false
    const bValues = [...bObj]
    for (const value of aObj) {
      if (!bValues.some((bValue) => structurallyEqual(value, bValue))) return false
    }
    return true
  }

  const aRecord = aObj as Record<string, unknown>
  const bRecord = bObj as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(bRecord, key) &&
      structurallyEqual(aRecord[key], bRecord[key]),
  )
}
