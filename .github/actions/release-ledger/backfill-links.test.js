const test = require('node:test'), assert = require('node:assert/strict');
const { workItemRelation } = require('./record');
test('empty legacy manifest does not clear recovered Work Item links on retry', () => {
  assert.equal(workItemRelation([], {relation:[{id:'recovered'}]}), undefined);
  assert.equal(workItemRelation([], {relation:[],has_more:true}), undefined);
});
test('normal manifest links and genuinely empty releases still write their relation', () => {
  assert.deepEqual(workItemRelation(['shipped'], {relation:[]}), {relation:[{id:'shipped'}]});
  assert.deepEqual(workItemRelation([], undefined), {relation:[]});
});
test('large relations remain preserved rather than truncated', () => {
  assert.equal(workItemRelation(Array.from({length:101},(_,i)=>String(i))), undefined);
});
