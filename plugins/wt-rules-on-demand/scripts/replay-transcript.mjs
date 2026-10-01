#!/usr/bin/env node
// Replays the MAIN loop of a real Claude Code transcript through hooks/hooks.js (runtime mode) with an
// in-memory store, then writes that store as JSON for compliance-report.mjs --store. It answers "what would
// the engine have served and judged on this session", offline: no model is called (a model compliance check
// records `unknown` with the reason "no classifier in replay" unless a classifier is passed in).
//
//   node scripts/replay-transcript.mjs --transcript <session.jsonl> --store-out <file>
//        [--config-dir <dir>] [--project-root <dir>]
import { readFile, readdir, writeFile, stat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configDirectory } from '../paths.js';

function toolEvent(use) {
  const input = use.input && typeof use.input === 'object' ? use.input : {};
  return {
    tool: use.name,
    input,
    ...(typeof input.command === 'string' ? { command: input.command } : {}),
    ...(typeof (input.file_path ?? input.path) === 'string' ? { path: input.file_path ?? input.path } : {}),
  };
}

function humanPrompt(record) {
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((block) => block.type === 'tool_result')) return null;
  const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  return text || null;
}

export async function replayTranscript({ transcriptText, configDir = configDirectory(process.env), projectRoot = process.cwd(), classify, hooksModule }) {
  const { register, resetForSelftest } = hooksModule ?? await import(new URL('../hooks/hooks.js', import.meta.url).href);
  const store = {};
  const logs = [];
  const messages = [];
  const records = transcriptText.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((record) => record && !record.isSidechain);
  const sessionId = records.find((record) => record.sessionId)?.sessionId ?? 'replay';
  const absolute = (path) => (isAbsolute(path) ? path : resolve(projectRoot, path));
  const $ = {
    ui: { log: async (text) => { logs.push(text); } },
    env: { get: async (name) => name === 'CLAUDE_CONFIG_DIR' ? configDir : process.env[name] },
    store: { get: async (key) => store[key], set: async (key, value) => { store[key] = value; } },
    // The replayed session is rooted at its project: project rules come from it and its ancestors, minus a main
    // checkout around a linked worktree, which the hook reads from the git files through this stub's `fs`.
    session: { id: async () => sessionId, messages: async () => messages, root: async () => resolve(projectRoot) },
    fs: {
       list: async (path) => (await readdir(absolute(path), { withFileTypes: true })).map((entry) => {
         let kind = 'other';
         if (entry.isFile()) kind = 'file';
         else if (entry.isDirectory()) kind = 'dir';
         return { name: entry.name, kind, isLink: entry.isSymbolicLink() };
       }),
       stat: async (path) => {
         const info = await stat(absolute(path));
         // A special file (socket, FIFO, device) is `other`, as the host and the startup command report it.
         return { kind: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other', size: info.size, realPath: await realpath(absolute(path)) };
       },
      read: async (path) => readFile(absolute(path), 'utf8'),
      write: async () => { throw new Error('replay never writes files'); },
    },
    model: { classify: classify ?? (async () => { throw new Error('no classifier in replay'); }) },
  };
  resetForSelftest();
  const hooks = [];
  register((event, matcher, hook) => hooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), { enabled: true });
  const run = (event, input, next) => {
    const hook = hooks.find((entry) => entry.event === event && (!entry.matcher || entry.matcher.tool?.test?.(input.tool) || entry.matcher.tool === input.tool));
    return hook ? hook.hook($, input, next) : next(input);
  };
  const counts = { prompts: 0, toolCalls: 0, refusals: 0, compactions: 0 };
  let turnOpen = false;
  await run('prompt.context', { blocks: [], cwd: projectRoot }, async (input) => input);
  for (const record of records) {
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      counts.compactions += 1;
      messages.length = 0;
      await run('session.compact', { trigger: 'auto', messages: [] }, async () => ({ messages: [] }));
       await run('prompt.context', { blocks: [], cwd: projectRoot }, async (input) => input);
      continue;
    }
    if (record.type === 'user') {
      const prompt = humanPrompt(record);
      if (prompt === null) continue;
      if (turnOpen) await run('turn.complete', {}, async () => ({ answer: '' }));
      turnOpen = true;
      counts.prompts += 1;
      messages.push({ role: 'user', text: prompt, toolUses: [] });
       await run('prompt.submit', { text: prompt, cwd: projectRoot }, async (input) => ({ text: input.text }));
      continue;
    }
    if (record.type !== 'assistant') continue;
    const uses = (record.message?.content ?? []).filter((block) => block.type === 'tool_use');
    messages.push({ role: 'assistant', text: '', toolUses: uses.map((use) => ({ name: use.name })) });
    for (const use of uses) {
      counts.toolCalls += 1;
       const result = await run('tool.call', { ...toolEvent(use), cwd: projectRoot }, async () => ({ result: {} }));
      if (result && 'deny' in result) counts.refusals += 1;
    }
  }
  if (turnOpen) await run('turn.complete', {}, async () => ({ answer: '' }));
  return { store, logs, counts };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--transcript', '--config-dir', '--store-out', '--project-root'].includes(flag)) {
      console.error(`unknown option: ${flag}`);
      process.exit(2);
    }
    options[flag.slice(2)] = args[++index];
  }
  if (!options.transcript || !options['store-out']) {
    console.error('usage: replay-transcript.mjs --transcript <file> --store-out <file> [--config-dir <dir>] [--project-root <dir>]');
    process.exit(2);
  }
  const { store, logs, counts } = await replayTranscript({
    transcriptText: await readFile(options.transcript, 'utf8'),
    configDir: options['config-dir'] ? resolve(options['config-dir']) : undefined,
    projectRoot: options['project-root'] ? resolve(options['project-root']) : process.cwd(),
  });
  await writeFile(options['store-out'], JSON.stringify(store));
  for (const line of logs.filter((text) => /skipped|shadow/.test(text))) console.error(line);
  console.log(`replayed ${counts.prompts} prompts, ${counts.toolCalls} tool calls, ${counts.refusals} refusals, ${counts.compactions} compactions -> ${options['store-out']}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
