#!/usr/bin/env node
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runExaDeepSearch } from '../src/deep/exa-search.js';
import { formatResult } from '../src/deep/format.js';
import { createHandleStore } from '../src/deep/handle.js';
import { startOpencode } from '../src/deep/opencode.js';
import { continueDeepResearch, startDeepResearch } from '../src/deep/runner.js';
import { ProviderFailure } from '../src/provider-failure.js';
import { detectProviders } from '../src/detect.js';

const MODES = new Set(['deep-lite', 'deep', 'deep-reasoning', 'agentic']);
const SHAPES = new Set(['prose', 'structured']);
const scriptPath = fileURLToPath(import.meta.url);
const store = createHandleStore();

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === 'json') {
      options.json = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

async function reconcile(record) {
  if (record.status !== 'running' || record.engine !== 'opencode' || !record.logPath) return record;
  let log;
  try {
    log = await readFile(record.logPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return record;
    throw error;
  }
  const marker = log.match(/(?:^|\n)EXIT=(\d+)\s*$/);
  if (!marker) return record;
  const output = log.slice(0, marker.index).trim();
  if (marker[1] !== '0') {
    const timeout = output.match(/(?:^|\n)TIMEOUT=(\d+)\s*$/);
    const spawnError = output.match(/(?:^|\n)SPAWN_ERROR=([^\s]+)\s*$/);
    return store.update(record.handle, {
      status: 'failed',
      error: timeout
        ? `opencode timed out after ${timeout[1]}ms`
        : marker[1] === '127'
          ? 'opencode was not found; install opencode and ensure it is on PATH'
          : spawnError
            ? `opencode failed to start: ${spawnError[1]}`
            : `opencode exited with status ${marker[1]}`,
    });
  }
  let result = output;
  if (record.shape === 'structured') {
    try {
      result = JSON.parse(output);
    } catch {
      return store.update(record.handle, {
        status: 'failed',
        error: 'opencode returned invalid structured JSON',
      });
    }
  }
  return store.update(record.handle, { status: 'done', result });
}

async function worker(handle) {
  const record = await store.read(handle);
  const options = {
    mode: record.mode,
    question: record.question,
    shape: record.shape,
    dir: record.dir,
    timeoutMs: record.timeoutMs,
    opencodePath: record.opencodePath,
  };
  const exa = {
    run: async (runOptions) => {
      if (!process.env.EXA_API_KEY) {
        throw new ProviderFailure('EXA_API_KEY is not set; Exa deep search is unavailable', {
          provider: 'exa',
          classification: 'missing',
        });
      }
      return runExaDeepSearch(
        { ...runOptions, apiKey: process.env.EXA_API_KEY },
        { fetch: globalThis.fetch },
      );
    },
  };
  const opencode = { start: (runOptions) => startOpencode(runOptions, { spawn, env: process.env }) };
  await continueDeepResearch(handle, options, { store, exa, opencode });
}

async function start(args) {
  // A deep-search run must never start another one. An agentic rung hands the question to an agent
  // with a shell, and an agent that finds this CLI will use it; the marker is set on every worker
  // the plugin launches, so this refusal closes the loop at its only entry point.
  if (process.env.DEEP_SEARCH_WORKER === '1') {
    throw new Error('Refusing to start: this process is already inside a deep-search run');
  }
  const flags = parseOptions(args);
  if (!MODES.has(flags.mode)) throw new Error(`Unknown deep-search mode: ${flags.mode ?? '(missing)'}`);
  if (flags.question && flags['question-file']) {
    throw new Error('Provide either --question or --question-file, not both');
  }
  const question = flags.question ?? (flags['question-file']
    ? await readFile(resolve(flags['question-file']), 'utf8')
    : '');
  if (!question.trim()) throw new Error('Missing deep-search question');
  const shape = flags.shape ?? 'prose';
  if (!SHAPES.has(shape)) throw new Error(`Unknown deep-search result shape: ${shape}`);
  // ⚠ NEVER the current directory by default. An agentic run works in whatever `--dir` names, and
  // when that was the plugin's own tree the agent read the plugin and re-ran it. A neutral, empty
  // directory under the state root gives it nothing to recurse into.
  const workDir = flags.dir ?? join(store.directory, 'work');
  if (!isAbsolute(workDir)) throw new Error(`--dir must be an absolute path: ${workDir}`);
  const providers = detectProviders(process.env, fs);
  if (process.env.DEEP_SEARCH_NO_WORKER !== '1' && !providers.exa.available && !providers.opencode.available) {
    throw new Error('No deep-search provider is available: set EXA_API_KEY, or install opencode and ensure it is on PATH. Ordinary web search still works.');
  }
  await mkdir(workDir, { recursive: true });
  const options = {
    mode: flags.mode,
    question,
    shape,
    dir: workDir,
    timeoutMs: 30 * 60_000,
    opencodePath: providers.opencode.available ? providers.opencode.path : undefined,
  };
  const answer = await startDeepResearch(options, {
    store,
    schedule: (handle) => {
      // ⚠ A TEST SEAM, and it exists because its absence SPENT REAL QUOTA. Measured 2026-09-21
      // 04:45 +01:00: `test/deep-recursion.test.js` starts an agentic run to assert the working
      // directory it records, and every suite run therefore detached a worker that launched a
      // REAL `opencode run` on the question "anything", with a 30-minute timeout. Nine of them in
      // one night, unattended, found only because the orphan watcher reported the processes.
      // A test that asserts what `start` RECORDS never needs the worker to exist.
      if (process.env.DEEP_SEARCH_NO_WORKER === '1') return;
      const child = spawn(process.execPath, [scriptPath, '__worker', handle], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
        cwd: process.cwd(),
      });
      child.unref();
    },
  });
  process.stdout.write(flags.json ? `${JSON.stringify(answer)}\n` : `${answer.handle}\n`);
}

async function status(handle) {
  if (!handle) throw new Error('Missing deep-search handle');
  const record = await reconcile(await store.read(handle));
  const endedAt = record.status === 'running' ? Date.now() : (record.updatedAt ?? Date.now());
  const elapsed = Math.max(0, endedAt - record.createdAt);
  const detail = record.status === 'failed' && record.error ? `: ${record.error}` : '';
  process.stdout.write(`${record.status} ${record.engine} ${elapsed}ms${detail}\n`);
}

async function result(handle, args) {
  if (!handle) throw new Error('Missing deep-search handle');
  const flags = parseOptions(args);
  const record = await reconcile(await store.read(handle));
  if (record.status !== 'done') {
    const detail = record.status === 'failed' && record.error ? `: ${record.error}` : '';
    throw new Error(`Deep-search run ${handle} is ${record.status}, not done${detail}`);
  }
  const shape = flags.shape ?? record.shape ?? 'prose';
  const answer = formatResult(record, { shape });
  process.stdout.write(shape === 'structured' ? `${JSON.stringify(answer)}\n` : `${answer}\n`);
}

async function list() {
  const records = await store.list();
  for (const original of records) {
    const record = await reconcile(original);
    process.stdout.write(`${record.handle} ${record.status} ${record.engine}\n`);
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '__worker') await worker(args[0]);
  else if (command === 'start') await start(args);
  else if (command === 'status') await status(args[0]);
  else if (command === 'result') await result(args[0], args.slice(1));
  else if (command === 'list') await list();
  else throw new Error(`Unknown deep-search command: ${command ?? '(missing)'}`);
} catch (error) {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
}
