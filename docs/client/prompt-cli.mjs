#!/usr/bin/env node
// Prints an orchestration prompt from orchestrator.js: node prompt-cli.mjs <build|verify|fix> <taskId> [round] [input.json]
import fs from 'node:fs'

const src = fs.readFileSync(new URL('./orchestrator.js', import.meta.url), 'utf8')
const head = src.split('\nconst results = await parallel')[0].replace('export const meta', 'const meta')
const api = new Function('args', 'agent', 'parallel', 'log', 'phase', head + '\nreturn { TASKS, buildPrompt, verifyPrompt, fixPrompt, RESULT, VERDICT }')(
  undefined, null, null, () => {}, () => {},
)

const [kind, id, roundArg, inputPath] = process.argv.slice(2)
const task = api.TASKS[id]
if (!task) throw new Error('unknown task: ' + id)
const round = Number(roundArg || 1)
const input = inputPath ? JSON.parse(fs.readFileSync(inputPath, 'utf8')) : {}

const prompts = {
  build: () => [api.buildPrompt(id, task), api.RESULT],
  verify: () => [api.verifyPrompt(id, task, input.report, round, input.prevBlocking || []), api.VERDICT],
  fix: () => [api.fixPrompt(id, task, input.verdict, round), api.RESULT],
}
if (!prompts[kind]) throw new Error('unknown kind: ' + kind)
const [text, schema] = prompts[kind]()

console.log([
  text,
  '',
  'FINAL MESSAGE: end your final message with exactly one JSON object (no code fence) matching this JSON schema. Keep every string short; the whole object must stay under 3000 characters.',
  JSON.stringify(schema),
].join('\n'))
