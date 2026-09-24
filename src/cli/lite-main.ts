#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildBaseProgram } from './base.js';
import { commanderExitCode, processIO } from './shared.js';

const program = buildBaseProgram({ cwd: process.cwd(), io: processIO }, { packageName: 'mcp-eval-kit-lite', pro: false }, (code) => {
  process.exitCode = code;
});
program.exitOverride();
try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) {
    process.exitCode = commanderExitCode(err);
  } else {
    throw err;
  }
}
