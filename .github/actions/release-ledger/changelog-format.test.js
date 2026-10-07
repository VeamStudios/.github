'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {ChangelogFormatError, validateChangelog} = require('./changelog-format');

// Synthetic text only. Existing release records and private changelog contents
// are deliberately not fixtures for this syntax validator.
const ID = '0123456789abcdef0123456789abcdef';
const UUID = '01234567-89ab-cdef-0123-456789abcdef';
const workItem = `https://www.notion.so/Example-${ID}`;
const sourcePr = 'https://github.com/ExampleOrg/ExampleRepo/pull/42';
const oneNote = (note = 'Improved report formatting.') => `# Example\n\n## 1.2.0\n### Fixed\n- ${note}\n`;
function fails(text, rule, line) {
  assert.throws(() => validateChangelog(text), error => {
    assert.ok(error instanceof ChangelogFormatError);
    assert.equal(error.code, 'invalid_changelog');
    assert.equal(error.details.rule, rule);
    assert.equal(error.details.ref.path, 'CHANGELOG.md');
    if (line !== undefined) {
      assert.equal(error.details.ref.startLine, line);
      assert.equal(error.details.ref.endLine, line);
    }
    return true;
  });
}

test('unchanged notes need neither Work Items nor source PR links', () => {
  const parsed = validateChangelog(oneNote());
  assert.equal(parsed.sections[0].version, '1.2.0');
  assert.equal(parsed.entries[0].summary, 'Improved report formatting.');
  assert.deepEqual(parsed.entries[0].workItems, []);
  assert.deepEqual(parsed.entries[0].prRefs, []);
  assert.equal(Object.hasOwn(parsed, 'covered'), false);
  assert.equal(Object.hasOwn(parsed, 'missing'), false);
});

test('legacy versions and category headings remain supported without a vocabulary gate', () => {
  const parsed = validateChangelog([
    '<!-- iOS -->', '# Example', '', '## [Unreleased]', '',
    '## [v5.9.0] - 2024-02-29', '### New', '- New option.',
    '### Changed', '* Better layout.', '### Internal', '- Updated tooling.',
    '### Custom category', '- A note.', '',
    '## 5.8', '### Feature', '- Legacy feature.', '### Fixed ', '- Legacy fix.', '',
  ].join('\n'));
  assert.deepEqual(parsed.sections.map(section => section.version), ['Unreleased', '5.9.0', '5.8.0']);
  assert.equal(parsed.sections[2].displayedVersion, '5.8');
  assert.equal(parsed.entries.length, 6);
  assert.deepEqual(parsed.sections[1].headings.map(heading => heading.name), ['New', 'Changed', 'Internal', 'Custom category']);
});

test('keeps multiline summaries, exact line ranges and existing metadata', () => {
  const parsed = validateChangelog([
    '# Example', '## 2.0.0', '### New', '- A new option.',
    '  More detail.', '  rcValue: option_enabled', '  previewTag: beta',
    '', '## 1.0.0', '### Fixed', '- An older note.', '',
  ].join('\r\n'));
  assert.equal(parsed.entries[0].summary, 'A new option.\nMore detail.');
  assert.deepEqual(parsed.entries[0].flagKeys, ['option_enabled']);
  assert.equal(parsed.entries[0].previewTag, 'beta');
  assert.deepEqual(parsed.entries[0].ref, {path: 'CHANGELOG.md', startLine: 4, endLine: 7});
  assert.deepEqual(parsed.sections[0].ref, {path: 'CHANGELOG.md', startLine: 2, endLine: 8});
  assert.equal(parsed.sections[0].entries[0], parsed.entries[0]);
});

test('maps valid inline and bare sources, deduplicating across continuation lines', () => {
  const parsed = validateChangelog(oneNote(`Better output. [Work Item](${workItem}) [PR](${sourcePr})\n  ${workItem} and [source](${sourcePr}#discussion_r123).`));
  assert.deepEqual(parsed.entries[0].workItems, [ID]);
  assert.deepEqual(parsed.entries[0].prRefs, [{repository: 'ExampleOrg/ExampleRepo', number: 42}]);
});

test('shared parser supports Notion variants and complete page IDs', () => {
  for (const url of [
    `https://notion.so/${ID}`, `https://team.notion.site/Title-${ID}?pvs=4`,
    `https://app.notion.com/p/${UUID}/`, `https://notion.so/Title-${UUID}`,
  ]) {
    assert.deepEqual(validateChangelog(oneNote(`[Work Item](${url})`)).entries[0].workItems, [ID]);
  }
});

test('differently labelled normal service links still retain their source mappings', () => {
  const entry = validateChangelog(oneNote(`[ticket](${workItem}), [details](${sourcePr}).`)).entries[0];
  assert.deepEqual(entry.workItems, [ID]);
  assert.deepEqual(entry.prRefs, [{repository: 'ExampleOrg/ExampleRepo', number: 42}]);
});

test('unrelated article links do not become required sources', () => {
  const entry = validateChangelog(oneNote('See [documentation](https://docs.example.org/guide) and https://github.com/ExampleOrg/ExampleRepo/issues/42.')).entries[0];
  assert.deepEqual(entry.workItems, []);
  assert.deepEqual(entry.prRefs, []);
});

test('Source may point to a normal Work Item or PR, with case-insensitive labels', () => {
  assert.deepEqual(validateChangelog(oneNote(`[SOURCE](${workItem})`)).entries[0].workItems, [ID]);
  assert.equal(validateChangelog(oneNote(`[Source PR](${sourcePr})`)).entries[0].prRefs[0].number, 42);
  assert.equal(validateChangelog(oneNote(`[PR #42](${sourcePr})`)).entries[0].prRefs[0].number, 42);
});

test('numbered PR labels agree with the destination and contain a valid integer', () => {
  for (const label of ['PR #41', 'Source PR #43', 'PR #0', 'PR #01', 'PR #-42', 'PR #1.2', 'PR #abc', 'PR #9007199254740992']) {
    fails(oneNote(`[${label}](${sourcePr})`), 'source_pr_link', 5);
  }
});

test('duplicate canonical versions include legacy and v-prefixed spellings', () => {
  fails('## 1.2\n### Fixed\n- First.\n## v1.2.0\n### New\n- Second.', 'duplicate_version', 4);
  fails('## Unreleased\n## [unreleased]', 'duplicate_version', 2);
});

test('versions are ordered numerically newest to oldest and Unreleased stays first', () => {
  validateChangelog('## 1.10.0\n### Fixed\n- Newer.\n## 1.9.0\n### Fixed\n- Older.');
  fails('## 1.9.0\n### Fixed\n- Older.\n## 1.10.0\n### Fixed\n- Newer.', 'version_order', 4);
  fails('## 1.2.0\n### Fixed\n- A note.\n## Unreleased', 'version_order', 4);
});

test('invalid, unsafe and unsupported version spellings report the heading', () => {
  for (const value of ['1', '1.2.3.4', '1.02.0', '1.2.0-beta', '-1.2.0', '9007199254740992.1.0']) {
    fails(`## ${value}\n### Fixed\n- A note.`, 'version', 1);
  }
  fails('## [1.2.0\n### Fixed\n- A note.', 'version', 1);
});

test('release dates must be real calendar dates', () => {
  for (const date of ['2023-02-29', '2024-02-30', '2024-13-01', '2024-00-12']) {
    fails(`## 1.2.0 - ${date}\n### Fixed\n- A note.`, 'date', 1);
  }
  validateChangelog('## [1.2.0] - 2024-02-29\n### Fixed\n- A note.');
});

test('empty numbered versions and categories fail, but bare Unreleased is allowed', () => {
  fails('## 1.2.0\n', 'empty_version', 1);
  fails('## 1.2.0\n### New\n### Fixed\n- A note.', 'empty_category', 2);
  fails('## Unreleased\n### Internal', 'empty_category', 2);
  assert.equal(validateChangelog('## Unreleased\n').entries.length, 0);
});

test('duplicate categories are detected without restricting category names', () => {
  fails('## 1.2.0\n### Fixed\n- First.\n### fixed\n- Second.', 'duplicate_category', 4);
  fails('## 1.2.0\n### Fixed\n- First.\n### Fixed ###\n- Second.', 'duplicate_category', 4);
  fails('## 1.2.0\n### ###\n- A note.', 'structure', 2);
  assert.equal(validateChangelog('## 1.2.0\n### Fixed ###\n- A note.').entries[0].heading, 'Fixed');
});

test('every nonblank line must belong to the supported structure', () => {
  fails('# Example\nUnexpected preamble.\n## 1.2.0\n### Fixed\n- Note.', 'structure', 2);
  fails('## 1.2.0\n- No category.', 'structure', 2);
  for (const text of ['Unexpected paragraph.', '1. Numbered note.', '### ', '- ', '```js', '  ```js', '  ### Hidden heading']) {
    fails(`## 1.2.0\n### Fixed\n- A note.\n${text}`, 'structure', 4);
  }
});

test('existing metadata cannot be empty or contain duplicate preview tags', () => {
  fails(oneNote('A note.\n  rcValue: '), 'metadata', 6);
  fails(oneNote('A note.\n  previewTag: beta\n  previewTag: stable'), 'metadata', 7);
});

test('empty, oversized and invalid text fails before parsing', () => {
  for (const value of [null, undefined, '', ' \n ']) fails(value, 'missing_changelog', 1);
  for (const value of [oneNote('A\0note.'), oneNote('\ud800'), 'a'.repeat(2 * 1024 * 1024 + 1)]) fails(value, 'input', 1);
  fails('## Unreleased\n' + '\n'.repeat(50000), 'input', 1);
  assert.equal(validateChangelog('\uFEFF' + oneNote()).entries.length, 1);
});

test('source links reject wrong schemes, credentials, explicit ports and encoded hostnames', () => {
  const urls = [
    workItem.replace('https:', 'http:'), workItem.replace('https:', 'ftp:'),
    workItem.replace('https://', 'https:/'), workItem.replace('https://', 'https://user:password@'),
    workItem.replace('notion.so', 'notion.so:443'), workItem.replace('notion.so', 'notion.so:8443'),
    workItem.replace('notion.so', '%6eotion.so'), workItem.replace('https://', '//'),
    workItem.replace('/Example-', '\\Example-'),
  ];
  for (const url of urls) fails(oneNote(`[Work Item](${url})`), 'source_url', 5);
  fails(oneNote(`[PR](${sourcePr.replace('https://', 'https://user@')})`), 'source_url', 5);
});

test('Work Item IDs reject incomplete or overlong IDs instead of matching a suffix', () => {
  for (const id of [ID.slice(1), `a${ID}`, `${ID}a`, UUID.slice(1), `${UUID}a`, 'not-an-id']) {
    fails(oneNote(`[Work Item](https://notion.so/${id})`), 'work_item_link', 5);
  }
});

test('Notion lookalikes and wrong hosts cannot masquerade as Work Items', () => {
  for (const url of [
    `https://notion.so.evil.example/${ID}`, `https://notion.so@evil.example/${ID}`,
    `https://evil.example/${ID}`, `https://github.com/ExampleOrg/ExampleRepo/pull/42`,
  ]) {
    assert.throws(() => validateChangelog(oneNote(`[Work Item](${url})`)), ChangelogFormatError);
  }
  fails(oneNote(`See https://notion.so.evil.example/${ID}.`), 'work_item_link', 5);
  fails(oneNote(`[ticket](http://notion.so/${ID})`), 'source_url', 5);
});

test('PR links require the normal GitHub host, PR path and a safe positive integer', () => {
  for (const url of [
    'https://github.com.evil.example/Org/Repo/pull/42',
    'https://gitlab.com/Org/Repo/pull/42', 'https://github.com/Org/Repo/issues/42',
    'https://github.com/Org/Repo/pull/0', 'https://github.com/Org/Repo/pull/-1',
    'https://github.com/Org/Repo/pull/01', 'https://github.com/Org/Repo/pull/1.2',
    'https://github.com/Org/Repo/pull/9007199254740992',
    'https://github.com/Org/Repo/pull/42/files',
  ]) fails(oneNote(`[PR](${url})`), 'source_pr_link', 5);
  fails(oneNote('https://github.com/Org/Repo/pull/not-a-number'), 'source_pr_link', 5);
  fails(oneNote('https://github.com.evil.example/Org/Repo/pull/42'), 'source_pr_link', 5);
  fails(oneNote('https://%67ithub.com/Org/Repo/pull/42'), 'source_url', 5);
});

test('explicit Source links cannot hide an unrelated host or a non-PR GitHub URL', () => {
  fails(oneNote('[source](https://example.org/guide)'), 'source_pr_link', 5);
  fails(oneNote('[source](https://github.com/Org/Repo/commit/abc)'), 'source_pr_link', 5);
});

test('incomplete or whitespace-containing inline source links fail on the actual line', () => {
  for (const note of ['[PR]()', `[PR](${sourcePr}`, `[Work Item](${workItem} extra)`, '[PR](/Org/Repo/pull/42)']) {
    assert.throws(() => validateChangelog(oneNote(note)), ChangelogFormatError);
  }
  fails(oneNote(`A note.\n  [Work Item](https://wrong.example/${ID})`), 'work_item_link', 6);
});

test('explicit source labels reject unsupported reference-style links with an inline fix', () => {
  for (const label of ['Work Item', 'PR', 'source']) {
    fails(oneNote(`[${label}][ticket]`), 'source_link', 5);
    fails(oneNote(`[${label}][]`), 'source_link', 5);
    fails(oneNote(`[${label}]\n  [${label}]: https://evil.example/no`), 'source_link', 6);
  }
  fails(oneNote(`[PR] (${sourcePr})`), 'source_link', 5);
});

test('normal source fragments and trailing URL punctuation do not change mappings', () => {
  const entry = validateChangelog(oneNote(`${sourcePr}?view=1#discussion; ${workItem},`)).entries[0];
  assert.deepEqual(entry.workItems, [ID]);
  assert.deepEqual(entry.prRefs, [{repository: 'ExampleOrg/ExampleRepo', number: 42}]);
});
