#!/usr/bin/env node
// The Java pack's language-server command: starts Eclipse JDT LS on a JVM of at least 21, passed through
// jdtls's own --java-executable, without changing the JAVA_HOME the project builds with. Every host read and
// the process spawn live in lib/host/jdtls-java.mjs.
import { planJdtlsLaunch, runJdtlsLaunch } from './lib/host/jdtls-java.mjs'

runJdtlsLaunch(planJdtlsLaunch(process.argv.slice(2)))
