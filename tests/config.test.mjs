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
