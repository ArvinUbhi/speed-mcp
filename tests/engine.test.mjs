import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, expression, checkWorkflow, get } from '../src/engine.mjs';
function fake(handler){const entry={workspace:'/repo',name:'s',fingerprint:'fp'};return {policy:{grants:{'/repo::s':{fingerprint:'fp',tools:['read','write']}}},entry:()=>entry,catalog:async()=>[{name:'read'},{name:'write'}],call:handler,sanitize:s=>s};}
const call=(id='one')=>({id,call:{server:'s',tool:'read'}});
const plan=steps=>({version:1,steps,return:{$ref:`steps.${steps.at(-1).id}`}});
test('chain results, foreach, projection and stable concurrent ordering',async()=>{
 const p=fake(async(s,t,a)=>a.id?{id:a.id,big:'discard'}:{items:[{id:3},{id:1},{id:2}]});
 const workflow=plan([call('jobs'),{id:'logs',forEach:{$ref:'steps.jobs.items'},concurrency:3,call:{server:'s',tool:'read',arguments:{id:{$ref:'item.id'}}},select:{id:{$ref:'result.id'}}}]);
 const result=await runWorkflow(workflow,p);assert.equal(result.ok,true);assert.deepEqual(result.result,[{id:3},{id:1},{id:2}]);assert.equal(result.stats.calls,4);assert.ok(result.stats.returnedBytes<result.stats.intermediateBytes);
});
test('pagination uses next cursor and flattens items',async()=>{
 const args=[];const p=fake(async(s,t,a)=>{args.push(a);return a.cursor?{items:[2],next:null}:{items:[1],next:'next'};});
 const result=await runWorkflow(plan([{...call(),paginate:{cursorArgument:'cursor',nextCursor:'next',items:'items',maxPages:3}}]),p);assert.deepEqual(result.result,[1,2]);assert.equal(args[1].cursor,'next');
});
test('page limit and repeated cursors are explicit errors',async()=>{
 for(const [maxPages,expected]of[[1,'PAGE_LIMIT'],[3,'PAGINATION_LOOP']]){
 const r=await runWorkflow(plan([{...call(),paginate:{cursorArgument:'cursor',nextCursor:'next',items:'items',maxPages}}]),fake(async()=>({items:[1],next:'same'})));assert.equal(r.error.code,expected);}
});
test('all tool grants are checked before first side effect',async()=>{
 let calls=0;const p=fake(async()=>{calls++;return {};});const r=await runWorkflow(plan([call(),{id:'bad',call:{server:'s',tool:'unapproved'}}]),p);assert.equal(r.ok,false);assert.equal(calls,0);assert.equal(r.error.code,'TOOL_NOT_APPROVED');
});
test('call budget, foreach item limit, output and memory limits',async()=>{
 let r=await runWorkflow({...plan([call('a'),call('b')]),maxCalls:1},fake(async()=>({})));assert.equal(r.error.code,'CALL_LIMIT');
 r=await runWorkflow({...plan([{...call(),forEach:[1,2]}]),maxItems:1},fake(async()=>({})));assert.equal(r.error.code,'ITEM_LIMIT');
 r=await runWorkflow(plan([call()]),fake(async()=>({big:'x'.repeat(100)})),{maxOutputBytes:10});assert.equal(r.error.code,'OUTPUT_LIMIT');
 r=await runWorkflow(plan([call()]),fake(async()=>({big:'x'.repeat(100)})),{maxMemoryBytes:10});assert.equal(r.error.code,'MEMORY_LIMIT');
});
test('errors stop execution with trace and do not retry',async()=>{
 let n=0;const r=await runWorkflow(plan([call('a'),call('b')]),fake(async()=>{n++;throw Error('failed');}));assert.equal(n,1);assert.equal(r.trace[0].status,'failed_or_unknown');assert.equal(r.ok,false);
});
test('deadline aborts a cancellable operation',async()=>{
 const p=fake(async(s,t,a,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})));
 const r=await runWorkflow({...plan([call()]),timeoutMs:100},p);assert.equal(r.ok,false);assert.equal(r.stats.calls,1);
});
test('conditions skip calls and return null',async()=>{let n=0;const r=await runWorkflow(plan([{...call(),when:false}]),fake(async()=>{n++;}));assert.equal(n,0);assert.equal(r.result,null);});
test('unknown syntax, duplicate ids and prototype paths fail clearly',()=>{
 assert.throws(()=>checkWorkflow(plan([call(),call()])),{code:'WORKFLOW_INVALID'});
 assert.throws(()=>checkWorkflow({...plan([call()]),code:'eval'}),{code:'WORKFLOW_INVALID'});
 assert.throws(()=>get({},'constructor.name'),{code:'REFERENCE_MISSING'});
 assert.throws(()=>expression({$op:'execute',input:1},{}),{code:'EXPRESSION_INVALID'});
});
test('expression map, filter, count, unique, take and flatten',()=>{
 const items=[{id:1,failed:true},{id:2,failed:false}];
 const filtered={$op:'filter',input:items,where:{$op:'equals',input:{$ref:'item.failed'},value:true}};
 assert.deepEqual(expression({$op:'map',input:filtered,select:{$ref:'item.id'}},{}),[1]);
 assert.equal(expression({$op:'count',input:items},{}),2);
 assert.deepEqual(expression({$op:'unique',input:[1,1,2]},{}),[1,2]);
 assert.deepEqual(expression({$op:'take',input:[1,2],limit:1},{}),[1]);
 assert.deepEqual(expression({$op:'flatten',input:[[1],[2]]},{}),[1,2]);
});
test('deadline cancels catalog discovery before any application call',async()=>{
 let rejectCatalog;let called=false;const p=fake(async()=>{called=true;});
 p.catalog=()=>new Promise((resolve,reject)=>{rejectCatalog=reject;});p.abort=()=>rejectCatalog?.(Error('catalog canceled'));
 const r=await runWorkflow({...plan([call()]),timeoutMs:100},p);assert.equal(r.ok,false);assert.equal(called,false);assert.ok(r.stats.durationMs<1000);
});
test('reference typos and invalid expression operands fail before any side effect',async()=>{
 for(const invalid of [{$ref:'steps.typo.id'},{$op:'map',input:[],wrong:1},{$ref:'item.id'},{$ref:'result.id'},{$op:'constructor',input:[]}]){
  let calls=0;const r=await runWorkflow({...plan([call()]),return:invalid},fake(async()=>{calls++;return {};}));assert.equal(r.ok,false);assert.equal(calls,0);
 }
 assert.throws(()=>checkWorkflow(plan([{...call(),call:{server:'s',tool:'read',arguments:{x:{$ref:'steps.one'}}}}])),{code:'REFERENCE_ORDER'});
});
test('dry run checks tools and estimates calls without application execution',async()=>{
 let calls=0;const p=fake(async()=>{calls++;});let validated=0;p.validateArguments=async()=>{validated++;};
 const r=await runWorkflow(plan([{...call(),forEach:[1,2,3],paginate:{cursorArgument:'cursor',items:'items',nextCursor:'next',maxPages:2}}]),p,{dryRun:true});
 assert.equal(r.ok,true);assert.equal(r.dryRun,true);assert.equal(r.estimatedMaximumCalls,6);assert.equal(r.stats.calls,0);assert.equal(calls,0);assert.equal(validated,1);
});
test('static argument errors on a later step prevent earlier application calls',async()=>{
 let calls=0;const p=fake(async()=>{calls++;});p.validateArguments=async(s,t,args)=>{if(args.bad)throw Object.assign(Error('bad arguments'),{code:'ARGUMENTS_INVALID'});};
 const r=await runWorkflow(plan([call('first'),{id:'second',call:{server:'s',tool:'read',arguments:{bad:true}}}]),p);
 assert.equal(r.error.code,'ARGUMENTS_INVALID');assert.equal(calls,0);
});
test('map scopes and literal references validate without inventing dependencies',()=>{
 checkWorkflow({version:1,steps:[{...call(),call:{server:'s',tool:'read',arguments:{value:{$literal:{$ref:'external.literal'}}}}}],return:{$op:'map',input:[{id:1}],select:{$ref:'item.id'}}});
});
