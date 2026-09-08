const {test} = require('node:test');
const assert = require('node:assert/strict');
const {releaseName, presentation, releaseSchema, targetFilter, TARGETS, PRODUCTS} = require('./presentation');
const schema = type => ({properties:{Target:{type},Products:{type:'relation',relation:{data_source_id:'30c06908-3a03-80ca-bd1b-000b2bbce6d8'}}}});
const m = {product:'Checklist Inspector Pro',target:'ios-consumer',version:'v2.2.0',event:'baseline'};
test('readable names keep edition and event distinctions without changing source data',()=>{
 const before=JSON.stringify(m);
 assert.equal(releaseName(m),'CIP iOS 2.2.0');
 assert.equal(releaseName({...m,product:'Site Audit Pro',target:'ios-enterprise',version:'10.7.0.1',event:'release'}),'SAP iOS Enterprise 10.7.0.1');
 assert.equal(releaseName({...m,product:'Shared CloudServices',target:'cloudservices',version:'v1.14.0'}),'CloudServices 1.14.0');
 assert.equal(releaseName({...m,event:'activation'}),'CIP iOS 2.2.0 — Activation');
 assert.equal(releaseName({...m,event:'withdrawal'}),'CIP iOS 2.2.0 — Withdrawal');
 assert.equal(releaseName({...m,product:'Another product',target:'console'}),'Another product Console 2.2.0');
 assert.equal(JSON.stringify(m),before);
});
test('all targets support legacy text and select reads/writes during conversion',async()=>{
 for(const [target,label] of Object.entries(TARGETS)) {
  const source={...m,target}, a=presentation(source,schema('rich_text')), b=presentation(source,schema('select'));
  assert.equal(a.Target.rich_text[0].text.content,target);assert.equal(b.Target.select.name,label);
  assert.equal(targetFilter(schema('rich_text'),target).rich_text.equals,target);
  assert.deepEqual(targetFilter(schema('select'),target).or.map(f=>f.select.equals),[label,target]);
 }
 await assert.rejects(releaseSchema(async()=>schema('number'),'releases'),/text or select/);
 await assert.rejects(releaseSchema(async()=>({properties:{Target:{type:'select'}}}),'releases'),/existing Products/);
});
test('relations are explicit and existing conflicting products fail before writes',()=>{
 const id=PRODUCTS[m.product], row={properties:{Products:{relation:[{id}]}}};
 assert.deepEqual(presentation(m,schema('select'),row).Products,row.properties.Products);
 assert.throws(()=>presentation(m,schema('select'),{properties:{Products:{relation:[{id:PRODUCTS.Shared}]}}}),/conflicts/);
 assert.throws(()=>presentation({...m,product:'Unknown'},schema('select')),/Unknown release product/);
 assert.throws(()=>presentation({...m,target:'future'},schema('select')),/Unknown release target/);
 assert.deepEqual(Object.keys(presentation(m,schema('select'))),['Name','Target','Products']);
});
