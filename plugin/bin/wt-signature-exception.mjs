#!/usr/bin/env node
import { runSignatureExceptionCli, signatureExceptionHelp } from './lib/host/signature-exception-cli.mjs'

const args = process.argv.slice(2)
if (args.length === 1 && ['--help', '-h'].includes(args[0])) console.log(signatureExceptionHelp)
else process.exitCode = runSignatureExceptionCli(args)
