import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCodexRunner, childEnvironment} from '../codex-runner.mjs';
import {adapterContract, assertProgressContract} from '../vendor/mosslive/sdk/testing.mjs';
const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const task = {sessionId: 'session-A', delegationId: 'task-A', context: [], purpose: 'task', objective: 'FIXTURE_WAIT'};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'moss-runner-')); let child, cwd;
  const run = createCodexRunner({codexPath: process.execPath, workspaceRoot: root, prefixArgs: [fake], onProcess: (c, _task, directory) => {child = c; cwd = directory;}});
  return {run, task, longTask: {...task, objective: 'FIXTURE_HANG'},
    waitStarted: async () => {for (let i = 0; i < 300; i++) {try {await readFile(join(cwd || root, 'fixture.json')); return;} catch {await sleep(10);}} throw Error('Fixture never started');},
    assertCompleted: async result => {assert.match(result, /FIXTURE_RESULT/); const state = JSON.parse(await readFile(join(cwd, 'fixture.json'))); assert.equal(state.hasMossKey, false); assert.equal(child.exitCode, 0);},
    assertStopped: () => {assert.ok(child.exitCode !== null || child.signalCode !== null); assert.throws(() => process.kill(child.pid, 0));},
    assertIsolatedFrom: async other => {assert.notEqual(root, other.root); assert.notEqual(cwd, other.cwd);},
    root, get cwd() {return cwd;}, cleanup: async () => {if (child && child.exitCode === null && child.signalCode === null) child.kill(); await rm(root, {recursive: true, force: true});},
  };
}
adapterContract(test, {createFixture: fixture, timeoutMs: 12000});
test('child never inherits unrelated API keys', () => {assert.deepEqual(childEnvironment({PATH: 'ok', MOSS_API_KEY: 'secret', CUSTOMER_BACKEND_KEY: 'secret2', OPENAI_API_KEY: 'secret3'}), {PATH: 'ok'});});
test('startup failure and empty or failed results reject', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moss-failure-'));
  try {
    const missing = createCodexRunner({codexPath: join(root, 'missing.exe'), workspaceRoot: root}); await assert.rejects(missing(task, {}), /未找到/);
    const run = createCodexRunner({codexPath: process.execPath, workspaceRoot: root, prefixArgs: [fake]});
    await assert.rejects(run({...task, objective: 'FIXTURE_FAIL'}, {}), /未完成/);
    await assert.rejects(run({...task, objective: 'FIXTURE_EMPTY'}, {}), /有效结果/);
  } finally {await rm(root, {recursive: true, force: true});}
});
test('progress is observable before the actual child completes', async () => {
  const f = await fixture(); await assertProgressContract({run: f.run, task: f.task, release: async () => {}, assertProgress: (updates, result) => {assert.ok(updates.length); assert.match(result, /FIXTURE_RESULT/);}, cleanup: f.cleanup});
});
