import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discover, expand, materialize, authorize, digest, loadPolicy, savePolicy } from '../src/config.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'speed-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function write(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));}
test('precedence: user < repo github < repo local < nearest github < explicit',async t=>{
 const root=await fixture(t),home=path.join(root,'home'),repo=path.join(root,'repo'),cwd=path.join(repo,'sub');await fs.mkdir(path.join(repo,'.git'),{recursive:true});await fs.mkdir(cwd);
 await write(path.join(home,'mcp-config.json'),{mcpServers:{x:{command:'user'},keep:{command:'yes'}}});
 await write(path.join(repo,'.github/mcp.json'),{mcpServers:{x:{command:'github'}}});
 await write(path.join(repo,'.mcp.json'),{mcpServers:{x:{command:'local'}}});
 await write(path.join(cwd,'.github/mcp.json'),{x:{command:'nearest'}});
 let d=await discover({workspace:cwd,copilotHome:home});assert.equal(d.servers.get('x').raw.command,'nearest');assert.ok(d.servers.has('keep'));
 await write(path.join(root,'extra.json'),{mcpServers:{x:{command:'explicit'}}});d=await discover({workspace:cwd,copilotHome:home,configs:[path.join(root,'extra.json')]});assert.equal(d.servers.get('x').raw.command,'explicit');
});
test('status discovery never executes commands and skips gateway recursion',async t=>{
 const root=await fixture(t);await write(path.join(root,'mcp-config.json'),{mcpServers:{'speed-mcp':{command:'bad'},renamed:{command:'node',args:['dist/speed-mcp.mjs','serve']},safe:{command:'nonexistent'}}});
 const d=await discover({workspace:root,copilotHome:root});assert.deepEqual([...d.servers.keys()],['safe']);
});
test('invalid JSON is an error, missing files are optional',async t=>{const root=await fixture(t);assert.equal((await discover({workspace:root,copilotHome:root})).servers.size,0);await fs.writeFile(path.join(root,'mcp-config.json'),'{bad');await assert.rejects(discover({workspace:root,copilotHome:root}),{code:'CONFIG_INVALID'});});
test('both environment forms expand, missing/input references fail closed',()=>{assert.equal(expand('${env:ABC}/${ABC}',{ABC:'test'}),'test/test');assert.throws(()=>expand('${ABSENT}',{}),{code:'ENV_MISSING'});assert.throws(()=>expand('${input:token}',{}),{code:'AUTH_UNAVAILABLE'});});
test('materialize rejects disabled, unsafe URL and host OAuth',()=>{
 const entry=raw=>({raw,workspace:process.cwd(),source:'/plugin/mcp.json',name:'test'});
 assert.throws(()=>materialize(entry({command:'node',disabled:true})),{code:'SERVER_DISABLED'});
 assert.throws(()=>materialize(entry({type:'http',url:'http://example.com/mcp'})),{code:'INSECURE_URL'});
 assert.throws(()=>materialize(entry({type:'http',url:'https://example.com/mcp',oauthClientId:'x'})),{code:'AUTH_UNAVAILABLE'});
 assert.equal(materialize(entry({command:'node',args:['${PLUGIN_ROOT}/run.mjs']})).args[0],'/plugin/run.mjs');
});
test('grants invalidate after config change and require exact tool names',()=>{
 const entry={name:'s',workspace:'/repo',fingerprint:digest({command:'node'})};const policy={grants:{'/repo::s':{fingerprint:entry.fingerprint,tools:['read']}}};
 assert.ok(authorize(entry,policy,'read'));assert.throws(()=>authorize(entry,policy,'write'),{code:'TOOL_NOT_APPROVED'});assert.throws(()=>authorize({...entry,fingerprint:'changed'},policy),{code:'SETUP_REQUIRED'});
});
test('policy save/load preserves approvals without secrets',async t=>{const root=await fixture(t);const p={version:1,grants:{a:{fingerprint:'hash',tools:['read']}}};const f=path.join(root,'data','policy.json');await savePolicy(p,f);assert.deepEqual(await loadPolicy(f),p);assert.deepEqual(await loadPolicy(path.join(root,'missing')),{version:1,grants:{}});});
test('Copilot export discovers plugin servers and preserves JSON approval hashes',async t=>{
 const root=await fixture(t);await write(path.join(root,'mcp-config.json'),{mcpServers:{user:{command:'node'}}});
 const base=await discover({workspace:root,copilotHome:root,inventoryReader:async()=>({mode:'json',servers:null})});
 const inventoryReader=async()=>({mode:'copilot+json',servers:{user:{command:'node',enabled:true,source:'user'},plugin:{type:'stdio',command:'node',args:['${PLUGIN_ROOT}/server.mjs'],env:{PLUGIN_ROOT:root},source:'plugin',sourcePlugin:'demo',sourcePluginVersion:'1.0.0'}}});
 const next=await discover({workspace:root,copilotHome:root,inventoryReader});
 assert.equal(next.servers.get('user').fingerprint,base.servers.get('user').fingerprint);
 assert.equal(materialize(next.servers.get('plugin')).args[0],`${root}/server.mjs`);
 assert.equal(next.discoveryMode,'copilot+json');assert.equal(next.servers.get('plugin').source,'copilot:plugin:demo');
});
test('Copilot disabled state is respected and explicit config retains precedence',async t=>{
 const root=await fixture(t);await write(path.join(root,'mcp-config.json'),{mcpServers:{user:{command:'node'}}});await write(path.join(root,'extra.json'),{mcpServers:{plugin:{command:'explicit'}}});
 const inventoryReader=async()=>({mode:'copilot+json',servers:{user:{command:'node',enabled:false},plugin:{command:'exported'}}});
 const d=await discover({workspace:root,copilotHome:root,inventoryReader,configs:[path.join(root,'extra.json')]});
 assert.throws(()=>materialize(d.servers.get('user')),{code:'SERVER_DISABLED'});assert.equal(d.servers.get('plugin').raw.command,'explicit');
});
test('parallel policy mutations preserve every independently approved server',async t=>{
 const {updatePolicy}=await import('../src/config.mjs');const root=await fixture(t);const file=path.join(root,'policy.json');
 await Promise.all(Array.from({length:8},(_,i)=>updatePolicy(async p=>{await new Promise(r=>setTimeout(r,5));p.grants[`workspace::server${i}`]={fingerprint:`hash${i}`,tools:['read']};},file)));
 assert.equal(Object.keys((await loadPolicy(file)).grants).length,8);
});
test('busy policy lock fails explicitly and invalid approvals fail closed',async t=>{
 const {updatePolicy}=await import('../src/config.mjs');const root=await fixture(t);const file=path.join(root,'policy.json');
 await fs.writeFile(`${file}.lock`,'{}');await assert.rejects(updatePolicy(()=>{},file,{timeoutMs:30}),{code:'POLICY_BUSY'});
 await write(file,{version:1,grants:{bad:{fingerprint:'hash',tools:'*'}}});await assert.rejects(loadPolicy(file),{code:'POLICY_INVALID'});
});
test('separate Node processes merge approvals without losing either update',async t=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {pathToFileURL}=await import('node:url');
 const root=await fixture(t);const file=path.join(root,'policy.json');const moduleUrl=pathToFileURL(path.resolve('src/config.mjs')).href;
 const code=`import {updatePolicy} from ${JSON.stringify(moduleUrl)};await updatePolicy(async p=>{await new Promise(r=>setTimeout(r,30));p.grants[process.argv[2]]={fingerprint:'hash',tools:['read']};},process.argv[1]);`;
 await Promise.all(['first','second'].map(key=>promisify(execFile)(process.execPath,['--input-type=module','-e',code,file,key])));
 assert.deepEqual(Object.keys((await loadPolicy(file)).grants).sort(),['first','second']);
});
