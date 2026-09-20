import { buildDeepPrompt } from './prompt.js';

const MODES = new Set(['deep-lite', 'deep', 'deep-reasoning', 'agentic']);
const SHAPES = new Set(['prose', 'structured']);

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function opencodePrompt(question, shape) {
  const prompt = buildDeepPrompt({ mode: 'agentic', question });
  if (shape === 'prose') return prompt;
  return `${prompt}\nReturn only JSON with claims (claim, url, date) and an unverified list.`;
}

function validate(options, deps) {
  const { mode, question, shape = 'prose' } = options;
  if (!MODES.has(mode)) throw new Error(`Unknown deep-search mode: ${mode}`);
  if (typeof question !== 'string' || !question.trim()) {
    throw new TypeError('Deep-search question must be a non-empty string');
  }
  if (!SHAPES.has(shape)) throw new Error(`Unknown deep-search result shape: ${shape}`);
  if (!deps?.store?.create || !deps?.store?.update) {
    throw new TypeError('Deep-search runner requires a handle store');
  }
}

export async function continueDeepResearch(handle, options, deps) {
  const { mode, question, shape = 'prose' } = options;
  if (!deps?.store?.update) throw new TypeError('Deep-search runner requires a handle store');
  const agentic = mode === 'agentic';

  const launchOpencode = async (door, cause = null) => {
    const launch = await deps.opencode.start({
      prompt: opencodePrompt(question, shape),
      dir: options.dir,
      logPath: options.logPath ?? `${deps.store.directory}/${handle}.log`,
      timeoutMs: options.timeoutMs,
    });
    await deps.store.update(handle, {
      status: 'running',
      engine: 'opencode',
      door,
      // Without this the reason Exa refused is LOST: the switch overwrites the record and a reader
      // sees a successful opencode run with no trace of what it replaced.
      ...(cause ? { exaError: cause.message, exaClassification: cause.classification } : {}),
      ...launch,
    });
  };

  const work = agentic
    ? (async () => {
        try {
          await launchOpencode('difficulty');
        } catch (error) {
          await deps.store.update(handle, {
            status: 'failed',
            engine: 'opencode',
            door: 'difficulty',
            error: message(error),
          });
        }
      })()
    : (async () => {
        try {
          const result = await deps.exa.run(options);
          await deps.store.update(handle, { status: 'done', engine: 'exa', result });
        } catch (error) {
          if (['exhausted', 'rate-limit', 'fatal'].includes(error?.classification)
            && deps.opencode?.start) {
            try {
              await launchOpencode('availability', {
                message: message(error),
                classification: error?.classification ?? null,
              });
              return;
            } catch (fallbackError) {
              await deps.store.update(handle, {
                status: 'failed',
                engine: 'opencode',
                door: 'availability',
                error: message(fallbackError),
              });
              return;
            }
          }
          await deps.store.update(handle, {
            status: 'failed',
            engine: 'exa',
            error: message(error),
          });
        }
      })();

  return work;
}

export async function startDeepResearch(options, deps) {
  validate(options, deps);
  const { mode, question, shape = 'prose' } = options;
  const agentic = mode === 'agentic';
  const initial = await deps.store.create({
    status: 'running',
    engine: agentic ? 'opencode' : 'exa',
    door: agentic ? 'difficulty' : null,
    mode,
    shape,
    question: question.trim(),
    effort: options.effort,
    dir: options.dir,
    timeoutMs: options.timeoutMs,
  });

  if (deps.schedule) {
    deps.schedule(initial.handle);
    return { handle: initial.handle };
  }

  continueDeepResearch(initial.handle, options, deps).catch(async (error) => {
    await deps.store.update(initial.handle, { status: 'failed', error: message(error) });
  });
  return { handle: initial.handle };
}
