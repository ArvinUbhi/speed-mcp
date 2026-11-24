import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copilotInventory } from '../src/copilot-config.mjs';
const fixture = path.resolve('tests/fixtures/copilot-export.mjs');
const options = { executable: process.execPath, workspace: process.cwd(), copilotHome: process.cwd() };
test('Copilot export reader accepts its supported envelope privately', async () => {
 const result = await copilotInventory({ ...options, commandArgs: [fixture, 'valid'] });
 assert.equal(result.mode, 'copilot+json'); assert.equal(result.servers.fixture.command, 'node');
 assert.equal(result.warning, undefined);
});
for (const mode of ['invalid','failure','oversize']) test(`Copilot ${mode} export falls back without exposing output`, async () => {
 const result = await copilotInventory({ ...options, commandArgs: [fixture, mode] });
 assert.equal(result.mode, 'json'); assert.equal(result.servers, null);
 assert.ok(result.warning); assert.ok(!result.warning.includes('private-auth-secret'));
});
test('Copilot export deadline terminates the process and returns fallback', async () => {
 const started = Date.now();
 const result = await copilotInventory({ ...options, commandArgs: [fixture, 'timeout'], timeoutMs: 100 });
 assert.equal(result.servers,null);assert.match(result.warning,/timed out/);assert.ok(Date.now()-started<2000);
});
test('Copilot export honors cancellation before spawning', async () => {
 const result = await copilotInventory({ ...options, signal: AbortSignal.abort() });
 assert.match(result.warning,/canceled/);assert.equal(result.servers,null);
});
test('dry-run cannot silently turn setup into a real approval change', async () => {
 const {parse}=await import('../src/cli.mjs');
 assert.throws(()=>parse(['setup','--dry-run','--yes','--server','s','--allow','read']),{code:'USAGE'});
 assert.equal(parse(['run','--dry-run','--file','plan.json']).options.dryRun,true);
});
