import { runWorkflow } from '../src/engine.mjs';
// Deliberately deterministic synthetic workload; no inference or production latency claims.
const entry={workspace:'/benchmark',name:'jobs',fingerprint:'fixture'};
const pool={entry:()=>entry,policy:{grants:{'/benchmark::jobs':{fingerprint:'fixture',tools:['list','logs']}}},catalog:async()=>[{name:'list'},{name:'logs'}],sanitize:s=>s,
 call:async(server,tool,args)=>tool==='list'?{items:Array.from({length:30},(_,id)=>({id}))}:{id:args.id,error:args.id%2?'timeout':'OOM',raw:'unrelated log data '.repeat(1000)}};
const result=await runWorkflow({version:1,steps:[{id:'jobs',call:{server:'jobs',tool:'list'}},{id:'logs',forEach:{$ref:'steps.jobs.items'},concurrency:4,call:{server:'jobs',tool:'logs',arguments:{id:{$ref:'item.id'}}},select:{id:{$ref:'result.id'},error:{$ref:'result.error'}}}],return:{$ref:'steps.logs'}},pool);
if(!result.ok)throw Error(JSON.stringify(result));
const report={workload:'Synthetic 30-job log investigation',upstreamCalls:result.stats.calls,normalizedIntermediateBytes:result.stats.intermediateBytes,projectedResultBytes:result.stats.returnedBytes,resultByteReductionPercent:Number((100*(1-result.stats.returnedBytes/result.stats.intermediateBytes)).toFixed(2)),note:'JSON result bytes only. Not measured tokens, model turns, wall-clock improvement or production savings.'};
console.log(JSON.stringify(report,null,2));
