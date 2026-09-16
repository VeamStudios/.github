const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('shared v3 token steps use client-id and never regress to the deprecated app-id', () => {
  const directory = path.join(__dirname, '../../workflows');
  let checked = 0;
  for (const file of fs.readdirSync(directory).filter(file => /\.ya?ml$/.test(file))) {
    const text = fs.readFileSync(path.join(directory, file), 'utf8');
    // Each step starts a new list item; named steps can put uses on a later line.
    for (const step of text.split(/\n(?=[ \t]*- (?:name|uses|id):)/)) {
      if (!/uses: actions\/create-github-app-token@v3(?:\s|$)/.test(step)) continue;
      checked++;
      assert.match(step, /\n[ \t]+client-id:.*CLIENT_ID/, file);
      assert.doesNotMatch(step, /\n[ \t]+app-id:/, file);
      assert.doesNotMatch(step, /\n[ \t]+client-id:.*APP_ID/, file);
      assert.match(step, /\n[ \t]+private-key:/, file);
    }
  }
  assert.ok(checked > 0, 'the check must inspect real token steps');
});
