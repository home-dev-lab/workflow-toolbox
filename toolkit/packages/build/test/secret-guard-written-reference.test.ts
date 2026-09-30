import { describe, expect, it } from 'vitest'
// @ts-expect-error shipped JavaScript module outside the TypeScript package
import { planReferences } from '../../../../plugins/wt-secret-guard/hooks/references.js'

const REF = 'op' + '://Private/item/field'
const REF2 = 'op' + '://Private/item/other'
const q = `'${REF}'`
const written: [string, string][] = [
  ['whole-word reference appended under a tilde path', `echo ${q} >> ~/.profile.secrets.perso.tpl`],
  ['card echo-append (the command from the card), the sole command', `echo 'export DEEPSEEK_API_KEY="${REF}"' >> ~/.profile.secrets.perso.tpl`],
  ['embedded reference piped to tee, the sole command', `echo 'export K="${REF}"' | tee -a f`],
  ['inject template written by printf, the sole command', `printf 'K={{ ${REF} }}\\n' > t`],
  ['bare', `echo ${REF} >> f`],
  ['single quoted', `echo ${q} >> f`],
  ['double quoted', `echo "${REF}" > f`],
  ['printf', `printf '%s\\n' ${q} >> f`],
  ['printf data after format', `printf '%s' ${q} -v >f`],
  ['printf end of options', `printf -- '-v%s' ${q} >f`],
  ['clobber', `echo ${q} >| f`],
  ['fd one', `echo ${q} 1>f`],
  ['separated fd is an operand', `echo ${q} 1 >f`],
  ['both fds', `echo ${q} &>f`],
  ['both fds append', `echo ${q} &>>f`],
  ['tee', `echo ${q} | tee f`],
  ['tee after pipeline newline', `echo ${q} |\ntee f`],
  ['tee append', `echo ${q} | tee -a f`],
  ['sudo tee', `echo ${q} | sudo tee -a f`],
  ['sudo with user', `echo ${q} | sudo -u root tee f`],
  ['zero-padded stdout descriptor', `echo ${q} 01>f`],
  ['assignment before tee', `echo ${q} | K=x tee f`],
  ['absolute echo', `/bin/echo ${q} > f`],
  ['builtin echo', `builtin echo ${q} > f`],
  ['command printf', `command printf '%s' ${q} > f`],
  ['assignment prefix', `K=x echo ${q} > f`],
  ['embedded operand', `echo export KEY='${REF}' >> env.sh`],
  ['template destination', `printf '%s' ${q} > /tmp/profile.tpl`],
]

describe('1Password references written as emitter operands', () => {
  for (const [shape, command] of written) it(`leaves ${shape} literal`, () => {
    const plan = planReferences(command)
    expect({ ok: plan.ok, reason: plan.reason, occurrences: plan.occurrences.length, invocations: plan.invocations.length }).toEqual({ ok: true, reason: '', occurrences: 0, invocations: 0 })
  })
})

const notWritten: [string, string][] = [
  ['curl', `curl -u ${q} u > out.json`],
  ['no redirection', `echo ${q}`],
  ['stderr only', `echo ${q} 2> e.log`],
  ['stdout to stderr', `echo ${q} >&2`],
  ['stdin redirected after stdout', `echo ${q} > f < in`],
  ['both fds via redirect', `echo ${q} >&f`],
  ['stderr then stdout copy', `echo ${q} 2>f 1>&2`],
  ['fd three then stdout copy', `echo ${q} 3>f 1>&3`],
  ['tee with stderr redirected', `echo ${q} 2>e.log | tee f`],
  ['stdout move onto itself', `echo ${q} >f 1>&1-`],
  ['fd replaced by input', `echo ${q} 3>f 3<in 1>&3`],
  ['input move closes stdout', `echo ${q} >f 0<&1-`],
  ['last redirect wins', `echo ${q} > f >&2`],
  ['spaced fd is an argument', `echo ${q} 2 >f 1>&2`],
  ['quoted fd is an argument', `echo ${q} '2'>f 1>&2`],
  ['stdout device', `echo ${q} > /dev/stdout`],
  ['stderr device', `echo ${q} > /dev/stderr`],
  ['tty device', `echo ${q} > /dev/tty`],
  ['null device', `echo ${q} > /dev/null`],
  ['fd device', `echo ${q} > /dev/fd/1`],
  ['proc fd device', `echo ${q} > /proc/self/fd/1`],
  ['udp device', `echo ${q} > /dev/udp/127.0.0.1/9`],
  ['tcp device', `echo ${q} > /dev/tcp/127.0.0.1/9`],
  ['pipe cat', `echo ${q} | cat`],
  ['tee no file', `echo ${q} | tee`],
  ['tee help writes no file', `echo ${q} | tee --help f`],
  ['tee stream operand', `echo ${q} | tee /dev/stdout`],
  ['tee with input redirect', `echo ${q} | tee f <in`],
  ['three stages across newline', `cat |\necho ${q} | tee f`],
  ['stdout redirected away from tee', `echo ${q} > /dev/stdout | tee f`],
  ['three stages', `echo ${q} | tee f | cat`],
  ['sudo query', `echo ${q} | sudo -l tee f`],
  ['printf variable', `printf -v X '%s' ${q} > f`],
  ['dynamic printf variable', `MODE=-v; printf "$MODE" X "%s" ${q} >f; curl -u "$X" u`],
  ['substitution preceding emitter', `K="$(op read ${q})" echo '${REF2}' >f`],
  ['command query', `command -v printf ${q} > f`],
  ['assignment reference', `K=${q} echo hi > f`],
  ['separated argument digit', `1 >f echo ${q}`],
  ['redirection before command name', `>f echo ${q}`],
  ['cat writes', `echo ${q} | cat > f`],
]

describe('non-written references retain develop planner outcome', () => {
  for (const [shape, command] of notWritten) it(shape, () => {
    const plan = planReferences(command)
    expect({ ok: plan.ok, reason: plan.reason, occurrences: plan.occurrences.length }).toEqual({ ok: true, reason: '', occurrences: 1 })
  })
})

it('keeps the develop invocation and occurrence for a substitution preceding an emitter', () => {
  const plan = planReferences(`K="$(op read ${q})" echo '${REF2}' >f`)
  expect({ ok: plan.ok, reason: plan.reason, occurrences: plan.occurrences.length, invocations: plan.invocations.length }).toEqual({ ok: true, reason: '', occurrences: 1, invocations: 1 })
})

it('refuses the account reference inside a substituted op read as on develop', () => {
  const plan = planReferences(`echo "$(op --account 'team:${REF}' read ${q})" >f`)
  expect({ ok: plan.ok, reason: plan.reason, occurrences: plan.occurrences.length, invocations: plan.invocations.length }).toEqual({ ok: false, reason: 'a reference that is not the whole quoted word', occurrences: 0, invocations: 1 })
})

it('refuses an embedded reference piped to tee --help as on develop', () => {
  const plan = planReferences(`echo 'prefix ${REF}' | tee --help f`)
  expect({ ok: plan.ok, reason: plan.reason, occurrences: plan.occurrences.length }).toEqual({ ok: false, reason: 'a reference that is not the whole quoted word', occurrences: 0 })
})

it('still refuses a runtime reference beside a template destination', () => {
  const plan = planReferences(`curl -u '${REF}' u > a.tpl`)
  expect({ ok: plan.ok, reason: plan.reason, occurrences: plan.occurrences.length }).toEqual({ ok: false, reason: 'a secret reference written to a 1Password template destination', occurrences: 1 })
})

const structural: [string, string, string][] = [
  ['xargs', `CLI=op; echo ${q} | tee f | xargs "$CLI" read`, '`xargs`, whose input becomes words of the command it runs'],
  ['eval', `echo ${q} > f; eval 'op inject -i f'`, '`eval`, which runs a string as shell code'],
  ['piped inject', `echo ${q} | op inject > f`, '`op inject` beside a secret reference'],
  ['later inject', `echo ${q} > f; op inject -i f`, '`op inject` beside a secret reference'],
  ['later run', `echo ${q} > f; op run -- echo hi`, '`op run` beside a secret reference'],
  ['unplaced op', `echo ${q} > f; op unknown`, 'an `op` invocation whose verb this guard cannot place (write it as `op [flags] read \'op://vault/item/field\'`)'],
  ['pipe stderr', `echo ${q} > f |& tee g`, 'the operator `|&`'],
  ['process substitution', `echo ${q} > >(cat)`, 'a command, process or arithmetic substitution'],
  ['command substitution', `echo "$(date)" ${q} >> f`, 'a command, process or arithmetic substitution'],
]
const suffix = ' - beside a secret reference this guard accepts only simple commands with literal command names, joined by ; && || | & or a newline'
describe('structural refusals remain as on develop', () => {
  for (const [shape, command, reason] of structural) it(shape, () => {
    const plan = planReferences(command)
    expect({ ok: plan.ok, reason: plan.reason, occurrences: plan.occurrences.length }).toEqual({ ok: false, reason: reason + (reason.includes('beside a secret reference') || reason.startsWith('`op ') || reason.startsWith('an `op` invocation') ? '' : suffix), occurrences: 1 })
  })
})

it('only the runtime value is rewritten in a mixed command', () => {
  const plan = planReferences(`echo ${q} > f; curl -u '${REF2}' u`)
  expect({ ok: plan.ok, reason: plan.reason, occurrences: plan.occurrences.length, invocations: plan.invocations.length }).toEqual({ ok: true, reason: '', occurrences: 1, invocations: 0 })
  expect(plan.occurrences[0]?.path).toBe('Private/item/other')
})

// A written reference that extent() refuses stays refused as on develop, except a reference that is
// not the whole quoted word in a command that is nothing but the writer: then nothing in the same
// command can run the file, and running it later needs a second tool call, as on develop.
const notWholeWord = 'a reference that is not the whole quoted word'
const writtenButRefused: [string, string, string][] = [
  ['card rewritten output line', `echo 'export DEEPSEEK_API_KEY=""$(op read --account 'my.1password.com' '${REF}')""' >> ~/.profile.secrets.perso.tpl`, 'a reference that does not end the shell word'],
  ['op read written into a script then run', `echo 'op read ${REF}' > /tmp/r.sh; bash /tmp/r.sh`, notWholeWord],
  ['op read written into a script then run after &&', `echo 'op read ${REF}' > r.sh && sh r.sh`, notWholeWord],
  ['embedded reference written in the background', `echo 'export K="${REF}"' > f &`, notWholeWord],
  ['embedded reference written by tee then piped on', `echo 'export K="${REF}"' | tee f | sh`, notWholeWord],
  ['embedded in a mixed command', `echo 'prefix ${REF}' > f; curl -u '${REF2}' u`, notWholeWord],
  ['backslash-escaped', `echo \\${REF} > f`, 'a reference preceded by a backslash escape'],
]
describe('written references that extent refuses keep the develop refusal', () => {
  for (const [shape, command, reason] of writtenButRefused) it(shape, () => {
    const plan = planReferences(command)
    expect({ ok: plan.ok, reason: plan.reason }).toEqual({ ok: false, reason })
  })
})

// The unquoted-tilde allowance covers only the redirection target of a written reference.
const tildeRefusal = 'an unquoted tilde (write the path out)' + suffix
const tildeRows: [string, string, boolean][] = [
  ['runtime reference redirected under a tilde', `curl -u ${q} u > ~/out.json`, false],
  ['file reference redirected under a tilde', `curl -u 'secret:file:/tmp/wt-env/X' u > ~/out.json`, false],
  ['written reference beside a runtime tilde target', `echo ${q} >> ~/f; curl -u '${REF2}' u > ~/out.json`, false],
  ['tilde target of an echo without a reference', `echo hi > ~/f; curl -u ${q} u`, false],
  ['written reference under a tilde', `echo ${q} >> ~/f`, true],
  ['written tilde beside a plain runtime target', `echo ${q} >> ~/f; curl -u '${REF2}' u > out.json`, true],
]
describe('the tilde allowance is confined to the write path', () => {
  for (const [shape, command, accepted] of tildeRows) it(shape, () => {
    const plan = planReferences(command)
    expect({ ok: plan.ok, reason: plan.reason }).toEqual(accepted ? { ok: true, reason: '' } : { ok: false, reason: tildeRefusal })
  })
})
