// Runs the real shared submit module in an isolated DOM double. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
let source = readFileSync('src/lib/lead-client.ts', 'utf8').replace(/^import .*;$/gm, '').replace(/export function/g, 'function');
if (process.env.BREAK === 'ga4') source = source.replace('if (!eventId) return;', "if (typeof fbq !== 'function' || !eventId) return;");
const compiled = ts.transpile(source, {target: ts.ScriptTarget.ES2022});
for (const mode of ['meta-absent', 'meta-throws', 'both', 'duplicate', 'failed']) {
  const google = [], meta = [], navigation = [];
  class Input { constructor(value='') { this.value=value; } setAttribute() {} }
  class Select extends Input {}
  class Button extends Input {}
  const fields = Object.fromEntries(Object.entries({email:'  LOCAL.PROOF@example.com  ',phone:'2025550182',first_name:'Local',last_name:'Proof',leadUuid:'local-uuid'}).map(([k,v])=>[k,new Input(v)]));
  let submit;
  const form = {elements:{namedItem:n=>fields[n]},querySelector:()=>null,addEventListener:(e,f)=>{if(e==='submit')submit=f;}};
  const context = vm.createContext({
    HTMLInputElement:Input, HTMLSelectElement:Select, HTMLButtonElement:Button,
    FormData:class {forEach(fn){for(const [k,v] of Object.entries(fields)) fn(v.value,k);}},
    readAttributionClient:()=>({leadUuid:'local-uuid'}),fullUrl:()=>'',validPhoneE164:()=>'+12025550182',META_PIXEL_ID:'local',
    crypto,TextEncoder,setTimeout,sessionStorage:{setItem(){}},window:{location:{assign:u=>navigation.push(u)}},
    fbq:mode==='meta-absent'?undefined:(...a)=>{if(mode==='meta-throws')throw Error('blocked');meta.push(a);},
    gtag:(...a)=>google.push(a),
    fetch:async()=>({json:async()=>({ok:mode!=='failed',duplicate:mode==='duplicate',eventId:'server-id',redirect:'/confirmed'})})
  });
  vm.runInContext(compiled,context);
  context.form=form;
  vm.runInContext('wireLeadForm({form})',context);
  submit({preventDefault(){}});
  await new Promise(r=>setTimeout(r,400));
  const converts=!['duplicate','failed'].includes(mode);
  assert.equal(google.length, converts?2:0,mode);
  if(converts){
    assert.deepEqual(JSON.parse(JSON.stringify(google)),[['set','user_data',{email:'local.proof@example.com',phone_number:'+12025550182'}],['event','generate_lead',{transaction_id:'server-id'}]],mode);
  }
  if(mode==='both')assert.equal(meta.find(a=>a[0]==='track')?.[3]?.eventID,'server-id');
  assert.equal(navigation.length,mode==='failed'?0:1,mode);
  console.log(`PASS client conversion: ${mode}`);
}
