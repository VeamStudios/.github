// Presentation-only adapter. Never feed these labels back into frozen manifests.
const TARGETS = { web: 'Web', website: 'Website', console: 'Console', backend: 'Backend', cloudservices: 'CloudServices', 'ios-consumer': 'iOS — Consumer', 'ios-enterprise': 'iOS — Enterprise', 'android-consumer': 'Android — Consumer', 'android-enterprise': 'Android — Enterprise' };
const PRODUCTS = { 'Site Audit Pro': '30c06908-3a03-80d0-9845-fe97daa54c31', 'Checklist Inspector Pro': '30c06908-3a03-8088-bfc4-f9a47469e4a6', Shared: '30c06908-3a03-80f0-8dad-c05ec91c35bb', 'Shared CloudServices': '30c06908-3a03-80f0-8dad-c05ec91c35bb' };
const PRODUCT_SOURCE = '30c069083a0380cabd1b000b2bbce6d8';
const normalize = value => value.replace(/-/g, '').toLowerCase();
function targetLabel(target) {
  if (!Object.hasOwn(TARGETS, target)) throw new Error(`Unknown release target: ${target}; add an explicit presentation mapping`);
  return TARGETS[target];
}
function releaseName(m) {
  const label = targetLabel(m.target).replace(' — Consumer', '').replace(' — Enterprise', ' Enterprise');
  const product = m.product === 'Site Audit Pro' ? 'SAP' : m.product === 'Checklist Inspector Pro' ? 'CIP' : m.product;
  const prefix = m.target === 'cloudservices' && ['Shared', 'Shared CloudServices'].includes(m.product) ? 'CloudServices' : `${product} ${label}`;
  const suffix = m.event === 'activation' ? ' — Activation' : m.event === 'withdrawal' ? ' — Withdrawal' : '';
  return `${prefix} ${m.version.replace(/^v(?=\d)/, '')}${suffix}`;
}
async function releaseSchema(notion, id) {
  const schema = await notion(`/data_sources/${id}`);
  const type = schema.properties?.Target?.type;
  if (!['rich_text', 'select'].includes(type)) throw new Error('Releases.Target must be text or select');
  const relation = schema.properties?.Products;
  if (relation?.type !== 'relation' || normalize(relation.relation?.data_source_id || '') !== PRODUCT_SOURCE) throw new Error('Releases.Products must relate to the existing Products data source');
  return schema;
}
function targetFilter(schema, target) {
  const label = targetLabel(target);
  if (schema.properties.Target.type === 'rich_text') return { property: 'Target', rich_text: { equals: target } };
  // The old machine option can briefly exist during in-place conversion.
  return { or: [...new Set([label, target])].map(name => ({ property: 'Target', select: { equals: name } })) };
}
function presentation(m, schema, row) {
  const label = targetLabel(m.target), productId = Object.hasOwn(PRODUCTS, m.product) ? PRODUCTS[m.product] : undefined;
  if (!productId) throw new Error(`Unknown release product: ${m.product}; map an existing Products page first`);
  const existing = row?.properties?.Products;
  if (existing?.has_more || (existing?.relation || []).some(r => normalize(r.id) !== normalize(productId))) throw new Error('Existing Products relation conflicts with the release product; reconcile manually');
  return {
    Name: { title: [{ text: { content: releaseName(m) } }] },
    Target: schema.properties.Target.type === 'select' ? { select: { name: label } } : { rich_text: [{ type: 'text', text: { content: m.target } }] },
    Products: existing?.relation?.length ? { relation: existing.relation.map(r => ({ id: r.id })) } : { relation: [{ id: productId }] },
  };
}
module.exports = { TARGETS, PRODUCTS, releaseName, releaseSchema, targetFilter, presentation };
