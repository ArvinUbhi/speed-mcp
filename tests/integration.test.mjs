import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { discover } from '../src/config.mjs';
import { Pool } from '../src/pool.mjs';
import { runWorkflow } from '../src/engine.mjs';
const exec=promisify(execFile);
const fixture=path.resolve('tests/fixtures/mcp-server.mjs');
async function prepare(t,raw){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'speed-live-'));
 await fs.writeFile(path.join(root,'mcp-config.json'),JSON.stringify({mcpServers:{fixture:raw}}));
 const inventory=await discover({workspace:root,copilotHome:root});const entry=inventory.servers.get('fixture');
 const policy={version:1,grants:{[`${entry.workspace}::fixture`]:{fingerprint:entry.fingerprint,tools:['jobs','logs','echo','error','slow']}}};
 const pool=new Pool(inventory,policy);t.after(async()=>{await pool.close();await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});return {root,inventory,policy,pool};
}
async function httpFixture(t,mode){
 const child=spawn(process.execPath,[fixture,mode],{env:{...process.env,EXPECT_AUTH:'Bearer fixture-secret'},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());let stderr='';child.stderr.on('data',d=>stderr+=d);
 const lines=readline.createInterface({input:child.stdout});
 const line=await Promise.race([once(lines,'line').then(x=>x[0]),once(child,'exit').then(()=>{throw Error(stderr);}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture startup timed out')),5000);timer.unref();})]);
 return JSON.parse(line).port;
}
test('real stdio handshake, schema validation, environment, projection and cleanup',async t=>{
 const {pool}=await prepare(t,{command:process.execPath,args:[fixture],env:{FIXTURE_ENV:'configured'}});
 assert.equal((await pool.catalog('fixture')).length,6);
 assert.equal((await pool.call('fixture','echo',{value:42})).env,'configured');
 await assert.rejects(pool.call('fixture','logs',{id:'wrong'}),{code:'ARGUMENTS_INVALID'});
 await assert.rejects(pool.call('fixture','mutate',{}),{code:'TOOL_NOT_APPROVED'});
 await assert.rejects(pool.call('fixture','error',{}),{code:'TOOL_REPORTED_ERROR'});
 const p={version:1,steps:[{id:'jobs',call:{server:'fixture',tool:'jobs'},paginate:{cursorArgument:'cursor',nextCursor:'next',items:'items',maxPages:3}},{id:'logs',forEach:{$ref:'steps.jobs'},concurrency:2,call:{server:'fixture',tool:'logs',arguments:{id:{$ref:'item.id'}}},select:{id:{$ref:'result.id'},error:{$ref:'result.error'}}}],return:{$ref:'steps.logs'}};
 const r=await runWorkflow(p,pool);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.result.length,3);assert.equal(r.stats.calls,5);assert.ok(r.stats.returnedBytes<r.stats.intermediateBytes/10);
 await pool.close();assert.equal(pool.closed,true);
});
for(const mode of ['http','sse'])test(`real ${mode} transport, authentication headers and no proxy for localhost`,async t=>{
 const port=await httpFixture(t,mode);const {pool}=await prepare(t,{type:mode,url:`http://127.0.0.1:${port}/${mode==='sse'?'sse':'mcp'}`,headers:{Authorization:'Bearer fixture-secret'}});
 const r=await pool.call('fixture','echo',{value:'remote'});assert.equal(r.value,'remote');
});
test('configured tool filtering applies to discovery and execution',async t=>{
 const {pool}=await prepare(t,{command:process.execPath,args:[fixture],tools:['jobs']});
 assert.deepEqual((await pool.catalog('fixture')).map(t=>t.name),['jobs']);await assert.rejects(pool.call('fixture','logs',{id:1}),{code:'TOOL_UNAVAILABLE'});
});
test('bad executable yields actionable error without server stderr',async t=>{
 const {pool}=await prepare(t,{command:'speed-mcp-executable-does-not-exist'});await assert.rejects(pool.catalog('fixture'),{code:'CONNECTION_FAILED'});
});
test('bundled gateway exposes exactly four tools and runs through MCP protocol',async t=>{
 const {root,policy}=await prepare(t,{command:process.execPath,args:[fixture]});
 const home=path.join(root,'policy');await fs.mkdir(home);await fs.writeFile(path.join(home,'policy.json'),JSON.stringify(policy));
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/speed-mcp.mjs'),'serve'],env:{...process.env,COPILOT_HOME:root,SPEED_MCP_HOME:home},stderr:'pipe'});transport.stderr?.on('data',()=>{});
 const client=new Client({name:'gateway-test',version:'1.0.0'});t.after(()=>client.close());await client.connect(transport);
 const tools=(await client.listTools()).tools;assert.equal(tools.length,4);
 const status=await client.callTool({name:'speed_mcp_status',arguments:{workspace:root}});assert.equal(JSON.parse(status.content[0].text).servers[0].state,'ready');
 const search=await client.callTool({name:'speed_mcp_search',arguments:{workspace:root,query:'logs'}});assert.equal(JSON.parse(search.content[0].text).matches[0].tool,'logs');
 const desc=await client.callTool({name:'speed_mcp_describe',arguments:{workspace:root,server:'fixture',tool:'echo'}});assert.deepEqual(JSON.parse(desc.content[0].text).inputSchema.required,['value']);
 const run=await client.callTool({name:'speed_mcp_run',arguments:{workspace:root,workflow:{version:1,steps:[{id:'x',call:{server:'fixture',tool:'echo',arguments:{value:7}}}],return:{$ref:'steps.x.value'}}}});
 assert.equal(JSON.parse(run.content[0].text).result,7);
 const bad=await client.callTool({name:'speed_mcp_run',arguments:{workspace:root,workflow:{code:'bad'}}});assert.equal(bad.isError,true);
});
test('bundle is portable without node_modules, including paths with spaces',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'speed portable '));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const target=path.join(root,'speed-mcp.mjs');await fs.copyFile('dist/speed-mcp.mjs',target);
 const {stdout}=await exec(process.execPath,[target,'status','--workspace',root],{cwd:root,env:{...process.env,COPILOT_HOME:root,SPEED_MCP_HOME:path.join(root,'data')}});assert.deepEqual(JSON.parse(stdout).servers,[]);
});
test('CLI noninteractive setup, doctor, run and revoke work end to end',async t=>{
 const {root}=await prepare(t,{command:process.execPath,args:[fixture]});const cli=path.resolve('dist/speed-mcp.mjs');const env={...process.env,COPILOT_HOME:root,SPEED_MCP_HOME:path.join(root,'policy')};
 const invoke=(...args)=>exec(process.execPath,[cli,...args,'--workspace',root],{env});
 const setup=JSON.parse((await invoke('setup','--server','fixture','--allow','echo','--yes')).stdout);assert.equal(setup.reports[0].state,'approved');
 const doctor=JSON.parse((await invoke('doctor')).stdout);assert.equal(doctor.servers[0].state,'connected');
 const file=path.join(root,'plan.json');await fs.writeFile(file,JSON.stringify({version:1,steps:[{id:'x',call:{server:'fixture',tool:'echo',arguments:{value:99}}}],return:{$ref:'steps.x.value'}}));
 assert.equal(JSON.parse((await invoke('run','--file',file)).stdout).result,99);
 await invoke('revoke','--server','fixture');assert.equal(JSON.parse((await invoke('status')).stdout).servers[0].state,'SETUP_REQUIRED');
});
test('authenticated environment HTTP proxy tunnels configured calls',async t=>{
 const {createServer}=await import('node:http');const {connect}=await import('node:net');
 const port=await httpFixture(t,'http');let proxyRequests=0;const sockets=new Set();
 const proxy=createServer();proxy.on('connect',(req,socket,head)=>{
  assert.equal(req.headers['proxy-authorization'],'Basic '+Buffer.from('user:password').toString('base64'));proxyRequests++;
  const upstream=connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
  sockets.add(socket);sockets.add(upstream);socket.on('error',()=>{});upstream.on('error',()=>socket.destroy());
 });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 t.after(()=>{for(const s of sockets)s.destroy();proxy.close();});
 const keys=['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy'];const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const proxyUrl=`http://user:password@127.0.0.1:${proxy.address().port}`;
 process.env.HTTP_PROXY=proxyUrl;process.env.http_proxy=proxyUrl;process.env.HTTPS_PROXY=proxyUrl;process.env.https_proxy=proxyUrl;process.env.NO_PROXY='';process.env.no_proxy='';
 try{
  const {pool}=await prepare(t,{type:'http',url:`http://127.0.0.1:${port}/mcp`,headers:{Authorization:'Bearer fixture-secret'}});
  assert.equal((await pool.call('fixture','echo',{value:'proxied'})).value,'proxied');assert.ok(proxyRequests>0);await pool.close();
 }finally{for(const k of keys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
});
test('bundled CLI executes when launched through a symlink',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'speed-symlink-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const alias=path.join(root,'alias.mjs');
 try{await fs.symlink(path.resolve('dist/speed-mcp.mjs'),alias,'file');}catch(e){if(process.platform==='win32'&&e.code==='EPERM'){t.skip('Windows runner does not permit file symlinks');return;}throw e;}
 const result=await exec(process.execPath,[alias,'status','--workspace',root],{env:{...process.env,COPILOT_HOME:root,SPEED_MCP_HOME:path.join(root,'data')}});assert.deepEqual(JSON.parse(result.stdout).servers,[]);
});
test('real dry run validates live schemas and leaves application call log empty',async t=>{
 const {randomUUID}=await import('node:crypto');const log=path.join(os.tmpdir(),`speed-dry-${randomUUID()}.log`);t.after(()=>fs.rm(log,{force:true}));
 const {pool}=await prepare(t,{command:process.execPath,args:[fixture],env:{CALL_LOG:log}});
 const valid={version:1,steps:[{id:'x',call:{server:'fixture',tool:'echo',arguments:{value:5}}}],return:{$ref:'steps.x'}};
 const r=await runWorkflow(valid,pool,{dryRun:true});assert.equal(r.ok,true);assert.equal(r.stats.calls,0);await assert.rejects(fs.access(log),{code:'ENOENT'});
 const invalid={version:1,steps:[{id:'first',call:{server:'fixture',tool:'jobs'}},{id:'bad',call:{server:'fixture',tool:'logs',arguments:{id:'wrong-type'}}}],return:{$ref:'steps.first'}};
 const bad=await runWorkflow(invalid,pool);assert.equal(bad.error.code,'ARGUMENTS_INVALID');assert.equal(bad.stats.calls,0);await assert.rejects(fs.access(log),{code:'ENOENT'});
});
