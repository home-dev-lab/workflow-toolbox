#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { reportSkillSizes } from './skill-size.mjs'

// Content reporting belongs in the authoring gate, never on a Skill invocation.
process.exitCode = reportSkillSizes(fileURLToPath(new URL('../../plugin/skills/', import.meta.url)))
