// Internal records in Feature Availability keep machine evidence off Work Items.
const DATA_SOURCE = 'b21439db-b5b5-433d-9b53-6e3cabf430b3';
const SCOPE = 'automation-state';
const text = p => (p?.rich_text || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
const rich = value => {const content=String(value);if(content.length>180000)throw Error('Automation evidence too large; refusing truncation');return {rich_text:(content.match(/[\s\S]{1,1800}/g)||[]).map(content=>({type:'text',text:{content}}))}};
const normalize = id => String(id).replace(/-/g,'').toLowerCase();
function key(id,kind) {
  if(!/^[a-f0-9]{32}$/.test(normalize(id))||!['development-Web','development-iOS','development-Android','remote-config','scope'].includes(kind))throw Error('Invalid automation state identity');
  return `automation/${normalize(id)}/${kind}`;
}
async function readState(notion,id,kind) {
  const identity=key(id,kind),result=await notion(`/data_sources/${DATA_SOURCE}/query`,'POST',{filter:{property:'Availability Key',rich_text:{equals:identity}},page_size:100});
  if(result.has_more||!Array.isArray(result.results)||result.results.length>1)throw Error('Ambiguous automation state');
  const row=result.results[0];if(!row)return {row:null,value:undefined};
  const p=row.properties,value=JSON.parse(text(p['Automation Evidence']));
  if(text(p['Availability Key'])!==identity||!value.value||typeof value.value!=='object'||Array.isArray(value.value)||text(p.Scope)!==SCOPE||p['Work Item']?.has_more||p['Work Item']?.relation?.length!==1||normalize(p['Work Item'].relation[0].id)!==normalize(id)||value.version!==1||value.workItem!==normalize(id)||value.kind!==kind)throw Error('Automation state identity mismatch');
  return {row,value:value.value};
}
async function writeState(notion,id,kind,value,title='Work Item') {
  const old=await readState(notion,id,kind);
  if(JSON.stringify(old.value)===JSON.stringify(value))return old.row;
  if(kind==='remote-config'&&old.value?.checkedAt&&Date.parse(old.value.checkedAt)>Date.parse(value.checkedAt))return old.row;
  const properties={'Availability Key':rich(key(id,kind)),Name:{title:[{text:{content:`Automation · ${title} · ${kind}`.slice(0,1800)}}]},Scope:rich(SCOPE),Target:rich('automation'),'Work Item':{relation:[{id}]},'Automation Evidence':rich(JSON.stringify({version:1,workItem:normalize(id),kind,value}))};
  if(old.row)return notion(`/pages/${old.row.id}`,'PATCH',{properties});
  try{return await notion('/pages','POST',{parent:{data_source_id:DATA_SOURCE},properties});}
  catch(error){const found=await readState(notion,id,kind);if(found.row&&JSON.stringify(found.value)===JSON.stringify(value))return found.row;throw error;}
}
module.exports={readState,writeState,key,DATA_SOURCE,SCOPE};
