import type {
  WorkflowRuntime,
  AgentOptions,
  Budget,
  PipelineStage,
} from './types.js'

/** A recorded agent() call, for post-hoc assertions in tests. */
export interface AgentCall {
  prompt: string
  opts: AgentOptions | undefined
  /** The active phase at call time (opts.phase takes precedence over the
   *  current phase set by phase()). Undefined if no phase was active. */
  phase: string | undefined
  /** 1-based index of this call across the lifetime of this FakeRuntime. */
  index: number
}

/** Options for constructing a FakeRuntime. */
export interface FakeRuntimeOptions {
  /** FIFO queue of responses. Each agent() call consumes one entry.
   *  A null entry simulates a skipped/failed agent (resolves to null).
   *  Mutually exclusive with onAgent. */
  responses?: ReadonlyArray<unknown>
  /** Handler called for every agent() invocation. May return a value or throw
   *  to simulate failure. Mutually exclusive with responses. Still budget-gated
   *  and charged agentTokenCost like any other agent() call. */
  onAgent?: (call: { prompt: string; opts?: AgentOptions; index: number }) => unknown | Promise<unknown>
  /** Token budget ceiling. null (default) = no budget constraint. */
  budgetTotal?: number | null
  /** Tokens charged per agent() call. Default 0. */
  agentTokenCost?: number
  /** Scripted child workflows for workflow(). Unknown names throw. */
  workflows?: Record<string, (args: unknown) => unknown | Promise<unknown>>
}

/**
 * FakeRuntime — a deterministic, scriptable WorkflowRuntime for unit-testing
 * pattern functions. Zero dependencies, no timers, no randomness.
 *
 * Usage:
 *   const rt = new FakeRuntime({ responses: ['classification', { score: 9 }] })
 *   const result = await myPattern(rt, { ... })
 *   expect(rt.calls[0].prompt).toContain('classify')
 */
export class FakeRuntime implements WorkflowRuntime {
  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------
  readonly #responses: ReadonlyArray<unknown> | undefined
  readonly #onAgent: FakeRuntimeOptions['onAgent']
  readonly #budgetTotal: number | null
  readonly #agentTokenCost: number
  readonly #workflows: Record<string, (args: unknown) => unknown | Promise<unknown>>

  #callIndex = 0
  #spent = 0
  #currentPhase: string | undefined

  readonly #calls: AgentCall[] = []
  readonly #phases: string[] = []
  readonly #logs: string[] = []

  // -------------------------------------------------------------------------
  // Public recording accessors
  // -------------------------------------------------------------------------
  /** All agent() calls in invocation order. */
  get calls(): readonly AgentCall[] { return this.#calls }
  /** phase() titles in call order. */
  get phases(): readonly string[] { return this.#phases }
  /** log() messages in call order. */
  get logs(): readonly string[] { return this.#logs }
  /** Total number of agent() calls made, including skipped (null) responses. */
  get agentsSpawned(): number { return this.#callIndex }

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------
  constructor(options?: FakeRuntimeOptions) {
    if (options?.responses !== undefined && options.onAgent !== undefined) {
      throw new Error('FakeRuntime: responses and onAgent are mutually exclusive — provide one or neither')
    }
    this.#responses = options?.responses
    this.#onAgent = options?.onAgent
    this.#budgetTotal = options?.budgetTotal ?? null
    this.#agentTokenCost = options?.agentTokenCost ?? 0
    this.#workflows = options?.workflows ?? {}

    // budget must be built here (not as a field initializer): field
    // initializers run before the constructor body sets #budgetTotal.
    this.budget = {
      total: this.#budgetTotal,
      spent: () => this.#spent,
      remaining: () => {
        if (this.#budgetTotal === null) return Infinity
        return Math.max(0, this.#budgetTotal - this.#spent)
      },
    }
  }

  // -------------------------------------------------------------------------
  // WorkflowRuntime implementation
  // -------------------------------------------------------------------------

  readonly agent = async <T = string>(prompt: string, opts?: AgentOptions): Promise<T | null> => {
    // Budget check: throw before spending if ceiling already reached
    if (this.#budgetTotal !== null && this.#spent >= this.#budgetTotal) {
      throw new Error(
        `WorkflowBudgetExceededError: budget exhausted (spent=${this.#spent}, total=${this.#budgetTotal}) — agent call would exceed ceiling`,
      )
    }

    this.#callIndex += 1
    const index = this.#callIndex

    // Resolve the active phase for this call
    const callPhase = opts?.phase ?? this.#currentPhase

    // Shallow-copy opts at record time so a caller reusing/mutating an opts
    // object across calls cannot retroactively alter the recorded history.
    // (schema is still shared by reference — treat schemas as immutable.)
    this.#calls.push({ prompt, opts: opts ? { ...opts } : undefined, phase: callPhase, index })

    // Charge cost after recording (mirroring: in-flight results kept on budget exhaustion)
    this.#spent += this.#agentTokenCost

    // Obtain the response
    let response: unknown
    if (this.#onAgent !== undefined) {
      const callArg = opts !== undefined
        ? { prompt, opts, index }
        : { prompt, index }
      response = await this.#onAgent(callArg)
    } else if (this.#responses !== undefined) {
      if (index > this.#responses.length) {
        throw new Error(
          `FakeRuntime: agent call #${index} but only ${this.#responses.length} response${this.#responses.length === 1 ? '' : 's'} scripted — prompt was: ${prompt}`,
        )
      }
      response = this.#responses[index - 1]
    } else {
      // No responses and no handler — treat every call as a null (skipped) agent
      response = null
    }

    return response as T | null
  }

  readonly parallel = async <T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<Array<T | null>> => {
    return Promise.all(
      thunks.map((thunk) =>
        // Promise.resolve().then(...) is load-bearing: a SYNCHRONOUSLY
        // throwing thunk must also resolve to null, not reject the whole call.
        Promise.resolve()
          .then(() => thunk())
          .then((v): T | null => v)
          .catch((): null => null),
      ),
    )
  }

  readonly pipeline = async (
    items: readonly unknown[],
    ...stages: readonly PipelineStage[]
  ): Promise<unknown[]> => {
    // Each item flows through all stages independently.
    // Items are processed concurrently (Promise.all) — observably equivalent
    // to the real runtime's no-barrier pipeline semantics.
    return Promise.all(
      items.map(async (originalItem, index) => {
        let prev: unknown = originalItem
        for (const stage of stages) {
          try {
            prev = await Promise.resolve(stage(prev, originalItem, index))
          } catch {
            // Stage threw — drop this item to null, skip remaining stages
            return null
          }
        }
        return prev
      }),
    )
  }

  phase(title: string): void {
    this.#phases.push(title)
    this.#currentPhase = title
  }

  log(message: string): void {
    this.#logs.push(message)
  }

  // budget is assigned in the constructor so arrow functions capture `this`
  // lexically without needing a `self` alias (no-this-alias compliance).
  readonly budget: Budget

  readonly workflow = async (
    nameOrRef: string | { scriptPath: string },
    args?: unknown,
  ): Promise<unknown> => {
    const name = typeof nameOrRef === 'string' ? nameOrRef : nameOrRef.scriptPath
    const handler = this.#workflows[name]
    if (handler === undefined) {
      throw new Error(
        `FakeRuntime: unknown workflow "${name}" — script it in FakeRuntimeOptions.workflows`,
      )
    }
    return handler(args)
  }
}
