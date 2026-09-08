const { test } = require('node:test');
const assert = require('node:assert/strict');
const { completeDevelopment, REPOSITORIES } = require('./complete-development');
const { rich, text, select, validateNote } = require('./record');
const wi = 'a'.repeat(32), repo = 'VeamStudios/SiteAuditPro-Web';
function fixture() {
  const config = { repo, number: 7, mode: 'live', lifecycleWrites: true, workItemsId: 'workitems' };
  const pr = { number: 7, merged: true, merged_at: '2026-09-08T10:00:00Z', base: { ref: 'main', repo: { full_name: repo } }, head: { sha: 'b'.repeat(40) }, merge_commit_sha: 'c'.repeat(40), html_url: `https://github.com/${repo}/pull/7`, body: `Work Items:\n- https://www.notion.so/${wi}` };
  const row = { parent: { data_source_id: 'workitems' }, properties: { Product: { relation: [{ id: REPOSITORIES[repo].product }] }, 'Work Item Status': { status: { name: 'In Development' } }, 'Web Dev Status': select('In Development'), 'iOS Dev Status': select('Not Started'), 'Platform Development': rich('') } };
  const reads = [], patches = [], open = [];
  const api = {
    gh: async path => { reads.push(path); return path.includes('?state=open') ? open : pr; },
    notion: async (path, method, body) => { if (method === 'PATCH') { patches.push(body.properties); Object.assign(row.properties, body.properties); } return row; },
  };
  return { config, pr, row, reads, patches, open, api };
}
test('main merge completes only its product/platform and atomically records exact PR evidence', async () => {
  const f = fixture(); await completeDevelopment(f.config, f.api);
  assert.equal(f.patches.length, 1); assert.equal(f.row.properties['Web Dev Status'].select.name, 'Done');
  assert.equal(f.row.properties['iOS Dev Status'].select.name, 'Not Started');
  assert.equal(f.row.properties['Work Item Status'].status.name, 'In Development');
  const evidence = JSON.parse(text(f.row.properties['Platform Development'])).Web;
  assert.equal(evidence.head, f.pr.head.sha); assert.equal(evidence.pr, 7);
});
test('closed unmerged PR and merge into another base do not complete development', async () => {
  for (const change of [pr => { pr.merged = false; }, pr => { pr.base.ref = 'release'; }]) {
    const f = fixture(); change(f.pr); await completeDevelopment(f.config, f.api); assert.equal(f.patches.length, 0);
  }
});
test('a retry cannot complete a new development cycle or downgrade Released', async () => {
  const f = fixture(); await completeDevelopment(f.config, f.api);
  for (const status of ['In Development', 'Released']) {
    f.row.properties['Web Dev Status'] = select(status); await completeDevelopment(f.config, f.api);
    assert.equal(f.row.properties['Web Dev Status'].select.name, status);
  }
  assert.equal(f.patches.length, 1);
});
test('Released without previous automation evidence is preserved too', async () => {
  const f = fixture(); f.row.properties['Web Dev Status'] = select('Released');
  await completeDevelopment(f.config, f.api); assert.equal(f.patches.length, 0);
});
test('open linked PR on page two blocks premature completion, including a draft', async () => {
  const f = fixture(); f.api.gh = async path => path.includes('?state=open') ? path.endsWith('page=1') ? Array.from({ length: 100 }, () => ({ body: '' })) : [{ draft: true, body: f.pr.body }] : f.pr;
  const result = await completeDevelopment(f.config, f.api); assert.equal(f.patches.length, 0); assert.match(result.skipped[0].reason, /Another linked/);
});
test('other Work Item open PR does not block, and PR without Work Items does nothing', async () => {
  const f = fixture(); f.open.push({ body: `Work Items:\n- https://www.notion.so/${'d'.repeat(32)}` });
  await completeDevelopment(f.config, f.api); assert.equal(f.patches.length, 1);
  const empty = fixture(); empty.pr.body = 'Fix a bug'; await completeDevelopment(empty.config, empty.api); assert.equal(empty.patches.length, 0);
});
test('wrong product, unknown repo and non-Work-Item page fail without mutation', async () => {
  for (const change of [f => { f.row.properties.Product.relation[0].id = 'f'.repeat(32); }, f => { f.row.parent.data_source_id = 'other'; }, f => { f.config.repo = 'VeamStudios/SiteAuditPro-Backend'; }]) {
    const f = fixture(); change(f); await assert.rejects(completeDevelopment(f.config, f.api)); assert.equal(f.patches.length, 0);
  }
});
test('unrelated open PR placeholders do not abort completion', async () => {
  const f = fixture();
  f.open.push({ body: 'Work Items:\n- <url>' });
  await completeDevelopment(f.config, f.api);
  assert.equal(f.patches.length, 1);
});
test('valid sibling links still block their Work Item despite malformed entries', async () => {
  const f = fixture();
  const other = 'd'.repeat(32);
  f.pr.body += `\n- https://www.notion.so/${other}`;
  f.open.push({ body: `Work Items:\n- <url>\n- https://www.notion.so/${wi}` });
  const result = await completeDevelopment(f.config, f.api);
  assert.deepEqual(result.skipped.map(x => x.id), [wi]);
  assert.deepEqual(result.changes.map(x => x.id), [other]);
  assert.equal(f.patches.length, 1);
});
test('malformed links on the completing PR still fail before any mutation', async () => {
  const f = fixture(); f.pr.body += '\n- <url>';
  await assert.rejects(completeDevelopment(f.config, f.api), /Invalid Work Items/);
  assert.equal(f.patches.length, 0);
  assert.ok(!f.reads.some(path => path.includes('?state=open')));
});
test('off performs no reads; shadow and disabled lifecycle writes produce a proposal only', async () => {
  const off = fixture(); off.config.mode = 'off'; await completeDevelopment(off.config, off.api); assert.equal(off.reads.length, 0);
  for (const config of [{ mode: 'shadow' }, { lifecycleWrites: false }]) {
    const f = fixture(); Object.assign(f.config, config); const result = await completeDevelopment(f.config, f.api);
    assert.equal(f.patches.length, 0); assert.equal(result.changes[0].written, false);
  }
});
test('older merge delivered after a newer completion cannot reset status', async () => {
  const f = fixture(); f.row.properties['Platform Development'] = rich(JSON.stringify({ Web: { repository: repo, pr: 8, mergedAt: '2026-09-08T11:00:00Z' } }));
  await completeDevelopment(f.config, f.api); assert.equal(f.patches.length, 0);
});
test('explicit committed incomplete declaration holds Done without waiting for a future PR to exist', async () => {
  const f = fixture(); f.pr.body += '\n\nRelease note: .release-notes/part-one.json';
  const note = { kind: 'feature', summary: 'Export reports', scope: 'export-v1', workItems: [wi], targets: ['web'], audience: 'All', limitations: '', requiredReleaseKeys: [], audienceGate: false, developmentComplete: false };
  f.api.gh = async path => path.includes('/contents/') ? { encoding: 'base64', content: Buffer.from(JSON.stringify(note)).toString('base64') } : f.pr;
  const result = await completeDevelopment(f.config, f.api); assert.match(result.skipped, /incomplete/); assert.equal(f.patches.length, 0);
  assert.throws(() => validateNote({ ...note, developmentComplete: 'false' }, [wi]), /boolean/);
});
