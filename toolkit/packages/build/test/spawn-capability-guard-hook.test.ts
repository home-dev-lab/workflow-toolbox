// spawn-capability-guard-hook.test.ts — behavior gates for plugin/bin/wt-spawn-capability-guard-hook.mjs
//
// WHAT THE GUARD IS FOR. Briefing an agent type that has no Write tool with "write your report to
// <path>" produces a silent, expensive failure: the agent does the work, cannot write, and ends
// its turn reporting success. Observed twice on this machine, ~120k tokens each, WITH a written
// rule and a memory note already describing it — which is why it is a hook and not a paragraph.
//
// Like the sibling hook tests, every case drives the REAL script as a child process with a crafted
// stdin payload and asserts stdout + exit code. Fixtures are hermetic: each test builds its own
// `.claude/agents/<type>.md` in a temp dir and points BOTH resolution roots (cwd and
// CLAUDE_CONFIG_DIR) at it, so the machine's real agent definitions can never make a case pass or
// fail by accident.
//
// The negative cases carry as much weight as the positive ones. A guard that denies a legitimate
// read-only brief gets routed around, and a routed-around guard protects nothing — so "allows a
// brief that merely NAMES a path to read" is a load-bearing assertion, not padding.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-spawn-capability-guard-hook.mjs')
const BRIEF_INTENT = join(REPO_ROOT, 'plugin/bin/lib/spawn-brief-intent.mjs')
const PLUGIN_AGENTS = join(REPO_ROOT, 'plugin/agents')
const PLUGIN_MANIFEST = join(REPO_ROOT, 'plugin/.claude-plugin/plugin.json')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** Build a temp project whose `.claude/agents/` holds one definition, and return its path. */
function projectWithAgent(name: string, frontmatter: string, body = 'body'): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-capability-guard-'))
  roots.push(root)
  const dir = join(root, '.claude', 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: test agent\n${frontmatter}\n---\n\n${body}\n`)
  return root
}

function run(payload: unknown, cwd: string, mode = 'enforce') {
  const journal = mkdtempSync(join(tmpdir(), 'wt-capability-journal-'))
  roots.push(journal)
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    // Point the user-level resolution root at an empty dir so only the fixture can match.
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(cwd, '.nonexistent-config'),
      WT_GUARD_JOURNAL_DIR: journal,
      WT_GUARD_JOURNAL_TEST_ORIGIN: '1',
      WT_GUARD_MODE: mode,
    },
  })
  expect(res.status).toBe(0)
  expect(res.stderr).not.toContain('FAILED OPEN')
  const denied = res.stdout.includes('"deny"')
  const records: GuardRecord[] = readdirSync(journal)
    .filter((name) => name.endsWith('.ndjson'))
    .flatMap((name) => readFileSync(join(journal, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
  return { denied, stdout: res.stdout, stderr: res.stderr, status: res.status, records }
}

interface GuardRecord {
  decision: string
  class: string
  origin: string
  reason: string
  evidence?: { pattern: string; phrase: string }
  shadow?: string[]
}

function spawnPayload(type: string, prompt: string, cwd: string) {
  return { tool_name: 'Agent', cwd, tool_input: { subagent_type: type, prompt } }
}

function readOnlySpawn(prompt: string) {
  const cwd = projectWithAgent('reader', 'tools: Read, Grep, Glob')
  return run(spawnPayload('reader', prompt, cwd), cwd)
}

function singleRecord(result: ReturnType<typeof run>, decision: string, classification: string) {
  expect(result.records).toHaveLength(1)
  expect(result.records[0]).toMatchObject({ decision, class: classification, origin: 'test' })
  return result.records[0]!
}

function journalPhrase(phrase: string) {
  return phrase.slice(0, 24).replace(/[^A-Za-z0-9._/,-]+/g, '?')
}

describe('wt-spawn-capability-guard-hook', () => {
  describe('suppressed candidates give one advisory and one warned record', () => {
    it.each([
      ['Do not write to /tmp/x.', 'write to /tmp/x.', 'write-to-path', 'negated'],
      ['Never write your report to /tmp/x.md', 'write your report to /tmp/x.md', 'write-to-path', 'negated'],
      ["Don't write the findings to /tmp/f.md", 'write the findings to /tmp/f.md', 'write-to-path', 'negated'],
      ['You must not write to ~/x', 'write to ~/x', 'write-to-path', 'negated'],
      ['**Do not** write to /tmp/x', 'write to /tmp/x', 'write-to-path', 'negated'],
      ['NEVER save output to /tmp/x', 'save output to /tmp/x', 'save-to-path', 'negated'],
      ['Do not write output to /tmp/x.', 'write output to /tmp/x.', 'write-to-path', 'negated'],
      ["N'écris pas dans /tmp/x", 'écris pas dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['N’écris jamais ton rapport dans /tmp/x', 'écris jamais ton rapport dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['Ne rédige pas dans /tmp/x', 'rédige pas dans /tmp/x', 'fr-depose', 'negated'],
      ["N'enregistre plus dans /tmp/x", 'enregistre plus dans /tmp/x', 'fr-depose', 'negated'],
      // Infinitive negation puts both particles BEFORE the verb.
      ['ne pas écrire dans /tmp/x', 'écrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['sans écrire dans /tmp/x', 'écrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['Ne jamais écrire ton rapport dans /tmp/x', 'écrire ton rapport dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['Veille à ne pas ecrire dans /tmp/x', 'ecrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['**Ne pas** écrire dans /tmp/x', 'écrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['Ne pas enregistrer dans /tmp/x', 'enregistrer dans /tmp/x', 'fr-depose', 'negated'],
      ['Tu ne dois pas écrire dans /home/x/repo.', 'écrire dans /home/x/repo.', 'fr-ecris-dans', 'negated'],
      ['Lis /tmp/p.md sans rien écrire dans /home/x/repo.', 'écrire dans /home/x/repo.', 'fr-ecris-dans', 'negated'],
      ["Pas besoin d'écrire dans /tmp/x : ton dernier message suffit.", 'écrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['Ne surtout pas écrire dans /tmp/x', 'écrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ["Il est interdit d'écrire dans ~/.claude/rules.", 'écrire dans ~/.claude/rules.', 'fr-ecris-dans', 'negated'],
      // A side clause carries its own negation; a "puis", "si", "ne" or "que" in another clause does not reverse it.
      ['Lis /home/x/plan.md sans écrire dans /home/x/repo, puis rends ton verdict.', 'écrire dans /home/x/repo', 'fr-ecris-dans', 'negated'],
      ['Vérifie si le hook marche, sans écrire dans ~/.claude.', 'écrire dans ~/.claude.', 'fr-ecris-dans', 'negated'],
      ['Lis le module qui ne compile pas, sans écrire dans /tmp/x.', 'écrire dans /tmp/x.', 'fr-ecris-dans', 'negated'],
      ['Analyse le dépôt sans écrire dans /home/x/repo, que tu dois laisser intact.', 'écrire dans /home/x/repo', 'fr-ecris-dans', 'negated'],
      ['Analyse le rapport oublié sans écrire dans /tmp/x', 'écrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['Ne pas écrire dans /tmp/avant', 'écrire dans /tmp/avant', 'fr-ecris-dans', 'negated'],
      ['Pas  besoin d’écrire dans /tmp/x', 'écrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['Ne pas **écrire** dans /tmp/x', 'écrire** dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['Lis /tmp/si/x.md sans écrire dans /tmp/x', 'écrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['nginx ne pouvait pas écrire dans /tmp/x', 'écrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['Tu ne devrais pas écrire dans /tmp/x', 'écrire dans /tmp/x', 'fr-ecris-dans', 'negated'],
      ['Never write your report to /tmp/x.md; your final message is the report.', 'write your report to /tmp/x.md', 'write-to-path', 'negated'],
      ['Compare its output to /tmp/expected.txt and report.', 'output to /tmp/expected.txt', 'save-to-path', 'noun'],
      ['Compare the JSON output to /tmp/expected.txt.', 'output to /tmp/expected.txt.', 'save-to-path', 'noun'],
      ['Compare command output to /tmp/expected.txt.', 'output to /tmp/expected.txt.', 'save-to-path', 'noun'],
      ['To not write your report to /tmp/x would violate the task.', 'write your report to /tmp/x', 'write-to-path', 'negated'],
      ['Compare the results, and after that output the report to /tmp/x.', 'output the report to /tmp/x.', 'save-to-path', 'noun'],
      ['Do not write to /tmp/a. Never save to /tmp/b', 'write to /tmp/a.', 'write-to-path', 'negated'],
    ])('%s', (prompt, phrase, pattern, suppression) => {
      const r = readOnlySpawn(prompt)
      expect(r.denied).toBe(false)
      const output = JSON.parse(r.stdout).hookSpecificOutput
      expect(output.hookEventName).toBe('PreToolUse')
      expect(output.permissionDecision).toBeUndefined()
      expect(output.additionalContext).toContain('ADVISORY')
      expect(output.additionalContext).toContain('reader')
      expect(output.additionalContext).toContain(`"${phrase}"`)
      expect(output.additionalContext).toContain(suppression)
      expect(output.additionalContext).toContain('Write')
      expect(output.additionalContext).toContain('final message')
      expect(output.additionalContext.split(/\r?\n/)).toHaveLength(1) // the advisory is one line
      const record = singleRecord(r, 'warned', suppression === 'negated' ? 'negated-write' : 'noun-output')
      expect(record.evidence).toEqual({ pattern, phrase: journalPhrase(phrase) })
      expect(record.reason).toContain(phrase)
    })
  })

  describe('uncertain, reversed, continued and affirmative instructions stay blocked', () => {
    it.each([
      'If the answer is no, write to /tmp/x.',
      'Do not just write to /tmp/x; include the appendix too.',
      'You cannot not write to /tmp/x.',
      'Why not write your report to /tmp/x?',
      'Do not forget to write your report to /tmp/r.md',
      "Don't fail to write your report to /tmp/r.md",
      "Don't hesitate to write your findings to /tmp/f.md",
      'Never hesitate to write your findings to /tmp/f.md',
      'Ne rédige que le rapport dans /tmp/x.',
      'Answer no\nécris ton rapport dans /tmp/x',
      'Output the results to /tmp/x.md',
      'Run it and output the log to /tmp/x',
      'Save its output to /tmp/x',
      'Do not write to /tmp/a but write the report to /tmp/b.md',
      'Do not write to /tmp/a. Write your report to /tmp/b.md',
      'Do not write to /tmp/a but to /tmp/b.',
      'Do not write only the summary to /tmp/x; include the details too.',
      'You cannot simply not write your report to /tmp/x',
      'N’écris pas dans /tmp/a, mais dans /tmp/b.',
      'N’écris pas seulement le résumé dans /tmp/x; inclus aussi les détails.',
      'Do not write the report to /tmp/x until the review is complete; then do so.',
      '**You cannot** **not** write to /tmp/x',
      'You can’t **not** write to /tmp/x',
      'Never\nwrite to /tmp/x',
      'Ne\nrédige pas dans /tmp/x',
      'You must output the report to /tmp/x',
      'Please also output the report to /tmp/x',
      '**Output** the report to /tmp/x',
      'Do not write to /tmp/a but output the report to /tmp/b',
      'Compare its output to /tmp/a then save the report to /tmp/b',
      'Never save output to /tmp/a but save the report to /tmp/b',
      'Do not write to /tmp/a and write to /tmp/b',
      'Do not, under any circumstances, write to /tmp/x',
      'You must not ever write to ~/x',
      'Do not mysteriously write to /tmp/x',
      'If necessary do not write to /tmp/x',
      'Écris pas dans /tmp/x',
      'Do not say REPORT WRITTEN',
      'Do not: write to /tmp/x',
      '- Output the report to /tmp/x',
      '1. Output the report to /tmp/x',
      'Read the diff; then output the report to /tmp/x',
      'You cannot not output the report to /tmp/x.',
      'Do not output to /tmp/a but to /tmp/b.',
      'You can’t **not** output the report to /tmp/x.',
      'Never output to /tmp/a but to /tmp/b.',
      ...['do', 'does', 'did', 'will', 'would', 'could', 'might', 'may'].map(
        (auxiliary) => `You ${auxiliary} output the report to /tmp/x.`,
      ),
      ...[';', ':', '!', '?'].map((boundary) => `Do not write to /tmp/a${boundary} use /tmp/b.`),
      // A continuation after a colon or semicolon still belongs to the same instruction sentence.
      'Do not write to /tmp/x: instead, put the report in /tmp/y.',
      'Do not write to /tmp/x; rather put the report in /tmp/y.',
      'N’écris pas dans /tmp/a : plutôt dans /tmp/b.',
      // French infinitive instructions: the verb is the infinitive, the obligation sits elsewhere.
      'Tu dois écrire ton rapport dans /tmp/r.md',
      'Tu dois ecrire ton rapport dans /tmp/r.md',
      "N'oublie pas d'écrire ton rapport dans /tmp/r.md",
      'Écrivez le rapport dans /tmp/r.md',
      'Ne pas écrire dans /tmp/a, mais dans /tmp/b.',
      'Sans écrire dans /tmp/a; écris plutôt dans /tmp/b.',
      'Tu écriras ton rapport dans /tmp/r.md',
      'Il faut que tu écrives ton rapport dans /tmp/r.md',
      'Pourquoi ne pas écrire ton rapport dans /tmp/r.md ?',
      'Ne pas écrire dans le code, uniquement dans /tmp/r.md',
      'Sans écrire dans le dépôt, mets ton rapport dans /tmp/r.md',
      'Tu ne dois écrire que dans /tmp/r.md',
      "N'hésite pas à écrire ton rapport dans /tmp/r.md",
      'Ne manque pas de rédiger le rapport dans /tmp/r.md',
      "Ne pas oublier d'écrire le rapport dans /tmp/r.md",
      'Si besoin, ne pas hésiter à écrire dans /tmp/r.md',
      // The prohibition must govern the verb itself: a negation elsewhere in the clause does not count.
      'Sans attendre tu dois enregistrer le rapport dans /tmp/x',
      'Le module ne marche pas et tu dois enregistrer le diagnostic dans /tmp/x',
      'Ne pas seulement enregistrer le résumé dans /tmp/x',
      'Tu ne peux pas ne pas rédiger le rapport dans /tmp/x',
      "Il n'est pas interdit de déposer le rapport dans /tmp/x ; fais-le maintenant.",
      'Ne pas enregistrer dans /tmp/a mais dans ./b.md',
      'Il faut ne pas rédiger qu’un résumé dans /tmp/x ; inclure aussi les détails.',
      'Use sans serif and run `enregistrer` dans /tmp/x.',
      // A decomposed accent (e + U+0301) is the same verb.
      'e\u0301crire dans /tmp/x',
      'Il faut ne pas seulement écrire le résumé dans /tmp/x; inclus aussi les détails.',
      ...['enregistrer', 'sauvegarder', 'déposer', 'deposer', 'rédiger', 'rediger'].map(
        (verb) => `Tu dois ${verb} le rapport dans /tmp/r.md`,
      ),
    ])('%s', (prompt) => {
      const r = readOnlySpawn(prompt)
      expect(r.denied).toBe(true)
      const record = singleRecord(r, 'blocked', 'no-write-tool')
      expect(record.reason).toContain('has no Write tool')
      expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBeUndefined()
    })
  })

  describe('evidence selects the earliest affirmative phrase, longest on a tie', () => {
    it.each([
      ['Write your report to /tmp/x', 'Write your report to /tmp/x', 'write-to-path'],
      ['Save to /tmp/a. Write to /tmp/b', 'Save to /tmp/a.', 'save-to-path'],
      ['Do not write to /tmp/a. Write your report to /tmp/b.md', 'Write your report to /tmp/b.md', 'write-to-path'],
      ['Do not write to /tmp/a and write to /tmp/b', 'write to /tmp/b', 'write-to-path'],
      ['Compare its output to /tmp/a then save the report to /tmp/b', 'save the report to /tmp/b', 'save-to-path'],
      ['Vérifie, puis écris ton rapport dans /tmp/r.md', 'écris ton rapport dans /tmp/r.md', 'fr-ecris-dans'],
      ['👉écris ton rapport dans /tmp/x', 'écris ton rapport dans /tmp/x', 'fr-ecris-dans'],
      ['Dépose le rapport dans ~/r.md', 'Dépose le rapport dans ~/r.md', 'fr-depose'],
      ['Write your findings to the agreed location', 'Write your findings to', 'write-report-to'],
      ['FINAL MESSAGE: REPORT WRITTEN: <path>', 'REPORT WRITTEN', 'report-written'],
      ['Write  your\treport to /tmp/x', 'Write  your\treport to /tmp/x', 'write-to-path'],
      ['Write to /tmp/x and send the report to the reviewer', 'Write to /tmp/x and send the report to', 'write-report-to'],
    ])('%s', (prompt, phrase, pattern) => {
      const r = readOnlySpawn(prompt)
      expect(r.denied).toBe(true)
      const record = singleRecord(r, 'blocked', 'no-write-tool')
      expect(record.evidence).toEqual({ pattern, phrase: journalPhrase(phrase) })
      expect(record.reason).toBe(`agent type "reader" has no Write tool; matched: "${phrase}"`)
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain(`"${phrase}"`)
    })

    it('passes the complete phrase to secret masking before journal truncation', () => {
      const cwd = projectWithAgent('reader', 'tools: Read')
      const secret = 'fixture-secret-that-is-longer-than-the-evidence-cap-' + 'z'.repeat(130)
      const salt = 'fixture-salt'
      const store = join(cwd, '.nonexistent-config', 'plugins', 'store')
      mkdirSync(store, { recursive: true })
      writeFileSync(join(store, 'wt-secret-guard.json'), JSON.stringify({
        salt,
        detections: { entries: [{
          sha256: createHash('sha256').update(`${salt}:${secret}`).digest('hex'),
          token: 'MASKED',
        }] },
      }))
      const r = run(spawnPayload('reader', `Write to /tmp/${secret}`, cwd), cwd)
      const record = singleRecord(r, 'blocked', 'no-write-tool')
      expect(record.evidence).toEqual({ pattern: 'write-to-path', phrase: 'Write?to?/tmp/MASKED' })
      expect(record.reason).toContain('Write to /tmp/MASKED')
      expect(record.reason).not.toContain(secret.slice(0, 10))
    })
  })

  describe('observe mode keeps suppressed candidates silent', () => {
    it.each(['Do not write to /tmp/x', 'Compare command output to /tmp/x'])('%s', (prompt) => {
      const cwd = projectWithAgent('reader', 'tools: Read')
      const r = run(spawnPayload('reader', prompt, cwd), cwd, 'observe')
      expect(r.stdout).toBe('')
      singleRecord(r, 'silent', prompt.startsWith('Do not') ? 'negated-write' : 'noun-output')
    })

    it('still denies an affirmative write request', () => {
      const cwd = projectWithAgent('reader', 'tools: Read')
      const r = run(spawnPayload('reader', 'Write to /tmp/x', cwd), cwd, 'observe')
      expect(r.denied).toBe(true)
      singleRecord(r, 'blocked', 'no-write-tool')
    })
  })

  describe('classification scales with repeated clauses', () => {
    // Separated clauses exercise boundary lookup; one unbroken clause exercises the context windows
    // around each candidate (a quadratic window scan took ~18 s at 8000 repetitions of the last row).
    // The bound is generous on purpose: linear classification takes tens of milliseconds, so only a
    // super-linear regression, never machine load, can cross it.
    it.each([
      'Write to /tmp/x.\n', 'Compare command output to /tmp/x.\n',
      'Write to /tmp/x ', 'Compare command output to /tmp/x ',
    ])(
      'classifies 20000 repetitions under 5000 ms: %s', (clause) => {
        // Evaluate the real classifier in a child, excluding input/resolution/journal work from timing.
        const script = `
          const fs = require('node:fs')
          const vm = require('node:vm')
          const source = fs.readFileSync(process.argv[1], 'utf8')
            .replace(/^#!.*\\n/, '')
            .replace(/^import .*$/gm, '')
            .replace("runFailOpenHook('wt-spawn-capability-guard-hook.mjs', main)", '')
          const lib = fs.readFileSync(process.argv[2], 'utf8').replace(/^export /gm, '')
          const prompt = JSON.parse(fs.readFileSync(0, 'utf8'))
          const result = vm.runInNewContext(lib + '\\n' + source + \`\n
            const start = performance.now()
            const intent = findWriteIntent(prompt)
            const routed = finalMessageRoutes(prompt).length > 0;
            ({ elapsed: performance.now() - start, pattern: intent.pattern, suppression: intent.suppression, routed })
          \`, { prompt, performance })
          console.log(JSON.stringify(result))
        `
        const res = spawnSync(process.execPath, ['-e', script, HOOK, BRIEF_INTENT], {
          input: JSON.stringify(clause.repeat(20000)), encoding: 'utf8', timeout: 90000,
        })
        expect(res.status, res.stderr).toBe(0)
        const result = JSON.parse(res.stdout)
        process.stdout.write(`classifier ${JSON.stringify(clause)}: ${result.elapsed.toFixed(1)} ms\n`)
        expect(result.pattern).toBe(clause.startsWith('Write') ? 'write-to-path' : 'save-to-path')
        expect(result.suppression).toBe(clause.startsWith('Write') ? undefined : 'noun')
        expect(result.routed).toBe(false)
        expect(result.elapsed).toBeLessThan(5000)
      }, 100000,
    )
  })

  describe('no matched candidate stays silent', () => {
    it.each([
      'without writing to /tmp/x',
      'Décrire ce que fait /home/x/script.mjs dans /tmp/x',
      'Lis les archives des écrivains dans /tmp/x.',
      'Use the `ecrire` command to inspect data in /tmp/x.',
      'Écrire le bloc méta délimité (`<!-- sr-meta v1 -->` … `<!-- /sr-meta -->`) en bas de la description',
      // Nouns and past participles describe, they do not instruct.
      'Aucune écriture dans ~/.claude/rules/ ni ailleurs',
      'Les brouillons sont écrits et prêts, dans le fichier /tmp/x.md',
      'Chaque ligne est écrite dans un journal durable (~/.local/state/x.jsonl)',
      'Read /tmp/x.diff and report',
    ])('%s', (prompt) => {
      const r = readOnlySpawn(prompt)
      expect(r.denied).toBe(false)
      expect(r.stdout).toBe('')
      expect(r.records).toEqual([])
    })
  })

  describe('denies when the type cannot write but the brief demands a file', () => {
    it('English: "write your report to <path>"', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read, Grep, Glob')
      const r = run(spawnPayload('groomer', 'Groom it. Write your report to /tmp/out.md', cwd), cwd)
      expect(r.denied).toBe(true)
      // The refusal must name the missing capability AND the fix, or it just blocks work.
      expect(r.stdout).toContain('NO Write tool')
      expect(r.stdout).toContain('final message')
    })

    it('the REPORT WRITTEN contract alone is enough to trigger it', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read, Grep, Glob')
      const r = run(spawnPayload('groomer', 'Do the work.\nFINAL MESSAGE: REPORT WRITTEN: <path>', cwd), cwd)
      expect(r.denied).toBe(true)
    })

    it('French with accents', () => {
      const cwd = projectWithAgent('lecteur', 'tools: Read, Grep')
      const r = run(spawnPayload('lecteur', 'Vérifie, puis écris ton rapport dans /tmp/r.md', cwd), cwd)
      expect(r.denied).toBe(true)
    })

    // Regression lock: the first implementation used `\bécri[st]\b`. JS word boundaries are built
    // on ASCII \w, so `\b` before `é` does not mean what it looks like, and the unaccented spelling
    // was not matched at all — a French pattern that could never fire on French briefs. A pattern
    // that cannot fire is worse than no pattern: it reads as coverage.
    it('French WITHOUT accents — the spelling that silently escaped the first implementation', () => {
      const cwd = projectWithAgent('lecteur', 'tools: Read, Grep')
      const r = run(spawnPayload('lecteur', 'Verifie, puis ecris ton rapport dans /tmp/r.md', cwd), cwd)
      expect(r.denied).toBe(true)
    })

    it('French: "dépose … dans ~/chemin"', () => {
      const cwd = projectWithAgent('lecteur', 'tools: Read')
      const r = run(spawnPayload('lecteur', 'Analyse puis dépose le résultat dans ~/audits/x.md', cwd), cwd)
      expect(r.denied).toBe(true)
    })

    it('a YAML inline list is parsed the same as a comma list', () => {
      const cwd = projectWithAgent('groomer', 'tools: [Read, Grep, Glob]')
      const r = run(spawnPayload('groomer', 'Write your findings to /tmp/x.md', cwd), cwd)
      expect(r.denied).toBe(true)
    })
  })

  describe('allows everything it has no business refusing', () => {
    it('a type that DOES declare Write', () => {
      const cwd = projectWithAgent('writer', 'tools: Read, Write, Bash')
      const r = run(spawnPayload('writer', 'Write your report to /tmp/out.md', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    it('a type with no tools: line at all — it inherits every tool', () => {
      const cwd = projectWithAgent('inherits', 'model: sonnet')
      const r = run(spawnPayload('inherits', 'Write your report to /tmp/out.md', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    it('tools: * means everything', () => {
      const cwd = projectWithAgent('star', 'tools: *')
      const r = run(spawnPayload('star', 'Write your report to /tmp/out.md', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    it('an unknown type — cannot judge, so says nothing', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read')
      const r = run(spawnPayload('does-not-exist', 'Write your report to /tmp/out.md', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    // The load-bearing negative: briefs name paths to READ constantly. Denying those would make
    // the guard a nuisance, and a nuisance guard gets disabled.
    it('a read-only brief that merely names a path', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read, Grep, Glob')
      const r = run(spawnPayload('groomer', 'Read /home/x/MEMORY.md and report in your final message.', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    it('French "décris" is not the verb "écris"', () => {
      const cwd = projectWithAgent('lecteur', 'tools: Read')
      const r = run(spawnPayload('lecteur', 'Décris ce que fait /home/x/script.mjs, sans rien modifier.', cwd), cwd)
      expect(r.denied).toBe(false)
    })

    it('a propose-only brief whose deliverable is the final message', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read, Grep, Glob')
      const r = run(
        spawnPayload('groomer', 'PROPOSE only. Your final message IS the proposal. Never edit.', cwd),
        cwd,
      )
      expect(r.denied).toBe(false)
    })

    it('a tool other than Agent', () => {
      const cwd = projectWithAgent('groomer', 'tools: Read')
      const r = run({ tool_name: 'Bash', tool_input: { command: 'echo write to /tmp/x' } }, cwd)
      expect(r.denied).toBe(false)
    })
  })

  describe('fails open, never closed', () => {
    it('malformed stdin produces no output and exit 0', () => {
      const res = spawnSync(process.execPath, [HOOK], { input: 'not json at all', encoding: 'utf8' })
      expect(res.stdout.trim()).toBe('')
      expect(res.status).toBe(0)
      expect(res.stderr).not.toContain('FAILED OPEN')
    })

    it('empty stdin produces no output and exit 0', () => {
      const res = spawnSync(process.execPath, [HOOK], { input: '', encoding: 'utf8' })
      expect(res.stdout.trim()).toBe('')
      expect(res.status).toBe(0)
      expect(res.stderr).not.toContain('FAILED OPEN')
    })
  })

  describe('Bash write route (active advisory) and shadow rules (decision unchanged)', () => {
    const FILE_BRIEF = 'Write your report to /tmp/r.md'
    function spawnWith(tools: string, prompt: string, body?: string, mode = 'enforce') {
      const cwd = projectWithAgent('typed', tools, body)
      return run(spawnPayload('typed', prompt, cwd), cwd, mode)
    }
    function bashAdvisory(result: ReturnType<typeof run>) {
      expect(result.denied).toBe(false)
      const record = singleRecord(result, 'warned', 'bash-write-route')
      expect(record.shadow).toBeUndefined()
      const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string
      expect(context.startsWith('[workflow-toolbox spawn-capability] ADVISORY')).toBe(true)
      expect(context).toContain('is not refused: this type can write through its Bash tool')
      expect(context).not.toContain('\n')
      expect(result.stdout).not.toContain('permissionDecision')
    }
    function shadowDeny(result: ReturnType<typeof run>, classes: string[]) {
      expect(result.denied).toBe(true)
      const record = singleRecord(result, 'blocked', 'no-write-tool')
      const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason as string
      if (classes.length === 0) {
        expect(record.shadow).toBeUndefined()
        expect(reason).not.toContain('Shadow:')
        return
      }
      expect(record.shadow).toEqual(classes)
      expect(reason).toContain(`Shadow: the ${classes.join(' and ')} precision rule would lift this refusal (measuring before it decides).`)
    }

    it('R4: a bare Bash tool is a write route, so the spawn is advised, not refused', () => {
      bashAdvisory(spawnWith('tools: Read, Bash', FILE_BRIEF))
    })
    it('R4: a scoped Bash(git *) entry is not a write route', () => {
      shadowDeny(spawnWith('tools: Read, Bash(git *)', FILE_BRIEF), [])
    })
    it('R4: a type without Bash keeps the refusal', () => {
      shadowDeny(spawnWith('tools: Read', FILE_BRIEF), [])
    })
    it('R4: disallowedTools naming Bash keeps the refusal', () => {
      shadowDeny(spawnWith('tools: Read, Bash\ndisallowedTools: Bash', FILE_BRIEF), [])
    })
    it.each([
      'Make exactly one Bash call and nothing else.',
      'Your entire job is exactly ONE Bash tool call.',
      'Use only one Bash command.',
      'Run ONE Bash call with no heredoc.',
      'Make only a single Bash invocation.',
    ])('R4: a definition pinning Bash to one call keeps the refusal: %s', (body) => {
      shadowDeny(spawnWith('tools: Bash, Read', FILE_BRIEF, body), [])
    })
    it('R4: the pin is found when CR characters sit in the definition body and frontmatter', () => {
      const root = mkdtempSync(join(tmpdir(), 'wt-capability-guard-'))
      roots.push(root)
      const dir = join(root, '.claude', 'agents')
      mkdirSync(dir, { recursive: true })
      const text = '---\r\nname: typed\r\ndescription: test agent\r\ntools: Bash, Read\r\n---\r\n\r\nMake exactly one Bash call\r\nand nothing else.\r\n'
      writeFileSync(join(dir, 'typed.md'), text)
      shadowDeny(run(spawnPayload('typed', FILE_BRIEF, root), root), [])
    })
    it.each(['opencode-envelope', 'opencode-verifier'])('R4: the shipped %s definition is pinned, so the refusal stays', (name) => {
      const root = mkdtempSync(join(tmpdir(), 'wt-capability-guard-'))
      roots.push(root)
      const dir = join(root, '.claude', 'agents')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${name}.md`), readFileSync(join(PLUGIN_AGENTS, `${name}.md`), 'utf8'))
      shadowDeny(run(spawnPayload(name, FILE_BRIEF, root), root), [])
    })
    it('R4: observe mode still speaks for the Bash advisory, and stays silent for a negation advisory', () => {
      const result = spawnWith('tools: Read, Bash', FILE_BRIEF, undefined, 'observe')
      expect(result.stdout).toContain('ADVISORY')
      expect(result.denied).toBe(false)
      const quiet = spawnWith('tools: Read, Bash', 'Do not write to /tmp/x', undefined, 'observe')
      expect(quiet.stdout).toBe('')
    })

    // Each row matches exactly ONE of the router's shapes (checked against the lib's own list), and the
    // refusal still stands with the shadow sentence.
    it.each([
      [0, 'Write your report to /tmp/r.md. If you lack the write tool, put the report in your final message.'],
      [1, 'Write your report to /tmp/r.md. It is not possible for you to write there; put the report in your final message.'],
      [2, 'Write your report to /tmp/r.md if you can write; you are blocked here, so instead make your FINAL MESSAGE the full report.'],
      [3, 'Write to /tmp/r.md? No: your final message is the full report.'],
      [4, 'Write your findings to your final message.'],
    ])('R2 shape %i: the refusal stands and the shadow names final-message-fallback', async (index, prompt) => {
      const lib = await import(pathToFileURL(BRIEF_INTENT).href)
      expect(lib.finalMessageRoutes(prompt)).toEqual([index])
      shadowDeny(spawnWith('tools: Read, Grep', prompt), ['final-message-fallback'])
    })
    it.each([
      'Refute-first, read-only; your final message is ONE line: REPORT WRITTEN: <verdict>. Write your full report to /tmp/r.md',
      'You are read-only, and your last message must be one line with the path. Write your report to /tmp/r.md',
      'Write your report to /tmp/r.md; you cannot write anywhere else, and your final message is one line: the path.',
      'You cannot modify code; give the summary in your final message and write the full report to /tmp/r.md.',
      'If you cannot finish, return your partial verdict in your final message. Write your report to /tmp/r.md.',
      'Write your report to /tmp/r.md. Your final message is ONE line: REPORT WRITTEN: <verdict>',
      // A carrier verb with an inability, followed by the status line: only the status-line exclusion keeps it silent.
      "Since you can't write files here, return in your final message one line: REPORT WRITTEN: <verdict>. Write your report to /tmp/r.md",
    ])('R2: a status-line or unrelated mention names no shadow: %s', (prompt) => {
      shadowDeny(spawnWith('tools: Read, Grep', prompt), [])
    })
    it.each([
      ['Please write into /home/x/.claude', 'write-to-path'],
      ['Écris dans /home/x/.claude', 'fr-ecris-dans'],
      ['Save the notes to /tmp/dir/', 'save-to-path'],
    ])('R1: a destination without a file extension still refuses and names the shadow: %s', (prompt, pattern) => {
      const result = spawnWith('tools: Read, Grep', prompt)
      shadowDeny(result, ['no-file-path'])
      expect(result.records[0]!.evidence!.pattern).toBe(pattern)
    })
    it('R1: one destination with a file extension, or a non-path candidate, leaves no shadow', () => {
      shadowDeny(spawnWith('tools: Read, Grep', 'Do X to /tmp/dir, then write your report to /tmp/r.md'), [])
      shadowDeny(spawnWith('tools: Read, Grep', 'Write into /tmp/dir/ and then write your report to /tmp/r.md'), [])
      shadowDeny(spawnWith('tools: Read, Grep', 'Write your findings to the agreed location'), [])
    })
    it('R1 and R2 together name both shadow classes', () => {
      shadowDeny(
        spawnWith('tools: Read, Grep', 'Write into /home/x/.claude. If you cannot write files, put the report in your final message.'),
        ['no-file-path', 'final-message-fallback'],
      )
    })
  })

  // A hook that is not registered never runs, and its passing unit tests then prove nothing about
  // the shipped product — the wiring is part of the behavior.
  it('is registered as a PreToolUse hook on Agent in the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
    const entries = manifest.hooks?.PreToolUse ?? []
    const wired = entries
      .filter((e: { matcher?: string }) => e.matcher === 'Agent')
      .flatMap((e: { hooks?: { command?: string }[] }) => e.hooks ?? [])
      .some((h: { command?: string }) => h.command?.includes('wt-spawn-capability-guard-hook.mjs'))
    expect(wired).toBe(true)
  })
})
