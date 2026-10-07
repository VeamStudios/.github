'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runAssessment } = require('./changelog-cursor');
const evidence = { repository: 'VeamStudios/Test', head: 'a'.repeat(40), base: 'b'.repeat(40), digest: 'c'.repeat(64), files: [] };
const assessment = { schemaVersion: 1, repository: evidence.repository, head: evidence.head, base: evidence.base, evidenceDigest: evidence.digest, outcome: 'pass', findings: [] };
const result = value => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(value) });
const readEvents = `
const suppliedEvidence = require('node:fs').readFileSync('evidence.json', 'utf8');
console.log(JSON.stringify({type:'tool_call',subtype:'started',call_id:'complete',tool_call:{readToolCall:{args:{path:'evidence.json'}}}}));
console.log(JSON.stringify({type:'tool_call',subtype:'completed',call_id:'complete',tool_call:{readToolCall:{result:{success:{content:suppliedEvidence,totalChars:suppliedEvidence.length,totalLines:1,isEmpty:false,exceededLimit:false}}}}}));
`;
async function fixture(t, body, version = 'reviewed-version', read = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-changelog-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'agent');
  await fs.writeFile(executable, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log(${JSON.stringify(version)});process.exit(0)}\n${read ? readEvents : ''}\n${body}`, { mode: 0o700 });
  return { executable, expectedVersion: 'reviewed-version', model: 'approved-model', apiKey: 'fake-test-key', timeoutMs: 5000 };
}
test('isolates evidence/config, removes ambient secrets, restricts CLI and returns matching assessment', async t => {
  const options = await fixture(t, `
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
assert.equal(process.env.GITHUB_TOKEN,undefined);assert.equal(process.env.NOTION_TOKEN,undefined);
assert.equal(process.env.CURSOR_API_KEY,'fake-test-key');
const cfg=JSON.parse(fs.readFileSync(path.join(process.env.CURSOR_CONFIG_DIR,'cli-config.json')));
assert.equal(cfg.sandbox.readBoundary,'workspace');assert.equal(cfg.approvalMode,'allowlist');
assert.deepEqual(cfg.permissions.deny,['Shell(*)','Write(**)','WebFetch(*)','Mcp(*:*)']);
assert.ok(process.argv.includes('--mode=ask'));assert.ok(!process.argv.includes('--force'));
assert.ok(process.argv.includes('--trust'));assert.ok(process.cwd().includes('changelog-assessment-'));
assert.deepEqual(fs.readdirSync(process.cwd()),['.cursor','evidence.json']);
assert.equal(cfg.sandbox.networkAccess,'user_config_only');
assert.deepEqual(JSON.parse(fs.readFileSync('.cursor/sandbox.json')), {type:'workspace_readonly',networkPolicy:{default:'deny',deny:['*']},disableTmpWrite:true});
assert.deepEqual(JSON.parse(fs.readFileSync('evidence.json')),${JSON.stringify(evidence)});
console.log(${JSON.stringify(result(assessment))});`);
  assert.deepEqual(await runAssessment(evidence, options), assessment);
});
for (const [name, body, pattern] of [
  ['shell tool', `console.log(JSON.stringify({type:'tool_call',subtype:'started',call_id:'x',tool_call:{shellToolCall:{args:{command:'bad'}}}}))`, /forbidden tool/],
  ['outside read', `console.log(JSON.stringify({type:'tool_call',subtype:'started',call_id:'x',tool_call:{readToolCall:{args:{path:'/etc/passwd'}}}}))`, /forbidden tool/],
  ['provider failure with sensitive stderr', `process.stderr.write('SENSITIVE CODE');process.exit(1)`, /provider failed/],
  ['malformed event', `console.log('not json')`, /invalid event/],
  ['missing terminal', `console.log(JSON.stringify({type:'system',subtype:'init'}))`, /terminal result/],
  ['stale identity', `console.log(${JSON.stringify(result({ ...assessment, head: 'd'.repeat(40) }))})`, /stale policy identity/],
  ['non JSON policy', `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'markdown answer'}))`, /policy JSON/],
  ['output limit', `process.stdout.write('x'.repeat(2*1024*1024))`, /output limit/],
]) test(`rejects ${name}`, async t => {
  await assert.rejects(runAssessment(evidence, await fixture(t, body)), pattern);
});
test('rejects executable version drift before provider invocation', async t => {
  await assert.rejects(runAssessment(evidence, await fixture(t, `throw Error('must not run')`, 'other-version')), /reviewed pin/);
});
test('terminates hung assessment without retry', async t => {
  const options = await fixture(t, 'setInterval(()=>{},1000)'); options.timeoutMs = 500;
  await assert.rejects(runAssessment(evidence, options), /timed out/);
});
test('permits only completed evidence read tool', async t => {
  const options = await fixture(t, `
console.log(JSON.stringify({type:'tool_call',subtype:'started',call_id:'read1',tool_call:{readToolCall:{args:{path:'evidence.json'}}}}));
console.log(JSON.stringify({type:'tool_call',subtype:'completed',call_id:'read1',tool_call:{readToolCall:{result:{success:{content:suppliedEvidence,totalChars:suppliedEvidence.length,totalLines:1,isEmpty:false,exceededLimit:false}}}}}));
console.log(${JSON.stringify(result(assessment))});`);
  assert.deepEqual(await runAssessment(evidence, options), assessment);
});
test('rejects incomplete input before launching a process', async t => {
  const options = await fixture(t, `throw Error('must not run')`);
  await assert.rejects(runAssessment({ ...evidence, data: 'x'.repeat(4*1024*1024) }, options), /input limit/);
});

test('rejects terminal answer without reading evidence', async t => {
  const options = await fixture(t, `console.log(${JSON.stringify(result(assessment))})`, 'reviewed-version', false);
  await assert.rejects(runAssessment(evidence, options), /invalid event/);
});
for (const [label, changes] of [
  ['truncated', 'exceededLimit:true'],
  ['different content', 'content:"wrong"'],
  ['incorrect count', 'totalChars:0'],
  ['missing completeness flag', 'exceededLimit:undefined'],
]) test(`rejects ${label} evidence read`, async t => {
  const badRead = readEvents.replace('exceededLimit:false', `exceededLimit:false,${changes}`);
  const options = await fixture(t, badRead + `console.log(${JSON.stringify(result(assessment))})`, 'reviewed-version', false);
  await assert.rejects(runAssessment(evidence, options), /invalid event/);
});

for (const [message, code] of [['Unauthorized API key SECRET', 'authentication'], ['Unknown model SECRET','model'], ['workspace is not trusted SECRET','workspace_trust'], ['sandbox unavailable SECRET','sandbox'], ['ECONNRESET SECRET','network'], ['other SECRET','cli_process']]) test(`classifies ${code} without provider stderr`, async t => {
  const options = await fixture(t, `process.stderr.write(${JSON.stringify(message)});process.exit(7)`);
  await assert.rejects(runAssessment(evidence, options), error => {
    assert.equal(error.code, code); assert.equal(error.stage, 'provider'); assert.equal(error.exitCode, 7); assert.ok(!error.message.includes('SECRET')); return true;
  });
});
