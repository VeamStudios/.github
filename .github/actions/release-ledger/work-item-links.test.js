const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseWorkItemLinks } = require('./work-item-links');
const { workItems, validateNote } = require('./record');
const workflow = fs.readFileSync(path.join(__dirname, '../../workflows/qa-pipeline.yml'), 'utf8');
const embedded = workflow.slice(workflow.indexOf('            function parseWorkItemLinks'), workflow.indexOf('            const { listedUrls, invalidEntries }'));
const governance = new Function(`${embedded}\nreturn parseWorkItemLinks;`)();
const a = 'a'.repeat(32), b = 'b'.repeat(32);
const cases = [
  ['canonical list', `Work Items:\n- https://www.notion.so/${a}\n- https://app.notion.com/p/${b}`, [a, b]],
  ['legacy singular', `Work Item: https://www.notion.so/${a}`, [a]],
  ['formatted legacy singular', `- **Notion Work Item:** [Feature](https://app.notion.com/p/${a})`, [a]],
  ['headings, CRLF and duplicates', `## Work Items:\r\n* https://www.notion.so/${a}\r\n* https://www.notion.so/${a}\r\n\r\nOther https://www.notion.so/${b}`, [a]],
  ['dashed page with view query', 'Work Item: https://app.notion.com/p/Feature-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa?v='+b, [a]],
  ['unrelated links ignored', `Design: https://www.notion.so/${a}`, []],
  ['unlinked fix', 'Release note: .release-notes/fix.json', []],
];
for (const [name, body, expected] of cases) test(`governance and release inclusion agree: ${name}`, () => {
  assert.deepEqual(governance(body), parseWorkItemLinks(body));
  assert.deepEqual(workItems(body), expected);
  assert.deepEqual(governance(body).invalidEntries, []);
});
for (const entry of ['https://example.com/'+a, 'https://notion.so.evil.test/'+a, 'https://app.notion.com/p/no-page-id?v='+a, 'https://user:pass@notion.so/'+a, 'https://www.notion.so/'+a+' trailing prose', 'not a link']) {
  test(`invalid explicit entry fails both consumers: ${entry}`, () => {
    const body = `Work Items:\n- https://www.notion.so/${b}\n- ${entry}`;
    assert.deepEqual(governance(body), parseWorkItemLinks(body));
    assert.equal(governance(body).invalidEntries.length, 1);
    assert.throws(() => workItems(body), /Invalid Work Items/);
  });
}
test('legacy singular feature note matches the same Work Item IDs as governance', () => {
  const ids = workItems(`Work Item: https://www.notion.so/${a}`);
  const note = { kind: 'feature', summary: 'Export reports', audience: 'All users', limitations: '', scope: 'export', targets: ['web'], requiredReleaseKeys: [], audienceGate: false, workItems: [a] };
  assert.deepEqual(validateNote(note, ids).workItems, [a]);
  assert.doesNotThrow(() => validateNote({ ...note, kind: 'fix', workItems: [] }, []));
});
