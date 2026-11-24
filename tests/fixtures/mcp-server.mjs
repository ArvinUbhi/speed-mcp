import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';

const tools = [
 { name: 'jobs', description: 'List jobs', inputSchema: { type:'object',properties:{cursor:{type:'string'}},additionalProperties:false }, annotations:{readOnlyHint:true} },
 { name: 'logs', description: 'Read logs for one job', inputSchema:{type:'object',required:['id'],properties:{id:{type:'integer'}},additionalProperties:false},annotations:{readOnlyHint:true} },
 { name: 'echo', description: 'Return supplied data', inputSchema:{type:'object',properties:{value:{}},required:['value'],additionalProperties:false},annotations:{readOnlyHint:true} },
 { name: 'mutate', description: 'A write operation', inputSchema:{type:'object',properties:{},additionalProperties:false} },
 { name: 'error', description: 'Report an MCP error', inputSchema:{type:'object',properties:{},additionalProperties:false} },
 { name: 'slow', description: 'Slow operation', inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true} }
];
function makeServer() {
 const s=new Server({name:'fixture',version:'1.0.0'},{capabilities:{tools:{}}});
 s.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
 s.setRequestHandler(CallToolRequestSchema,async(req)=>{
  const {name,arguments:a={}}=req.params;
  if(process.env.CALL_LOG) await fs.appendFile(process.env.CALL_LOG,JSON.stringify({name,args:a})+'\n');
  if(name==='error')return {isError:true,content:[{type:'text',text:'private server error'}]};
  if(name==='slow')await new Promise(r=>setTimeout(r,2000));
  let value;
  if(name==='jobs')value=a.cursor?{items:[{id:3}],next:null}:{items:[{id:1},{id:2}],next:'page2'};
  else if(name==='logs')value={id:a.id,error:a.id===2?'OOM':'timeout',discard:'x'.repeat(1000)};
  else if(name==='echo')value={value:a.value,env:process.env.FIXTURE_ENV??null};
  else value={done:true};
  return {structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};
 });return s;
}
if(process.argv[2]==='http'||process.argv[2]==='sse'){
 const mode=process.argv[2];const sessions=new Map();
 const http=createServer(async(req,res)=>{
  try{
   if(process.env.EXPECT_AUTH&&req.headers.authorization!==process.env.EXPECT_AUTH){res.writeHead(401).end();return;}
   if(mode==='sse'){
    if(req.method==='GET'&&req.url==='/sse'){
     const t=new SSEServerTransport('/messages',res);const s=makeServer();sessions.set(t.sessionId,{s,t});await s.connect(t);return;
    }
    const id=new URL(req.url,'http://localhost').searchParams.get('sessionId');const v=sessions.get(id);
    if(!v){res.writeHead(404).end();return;}await v.t.handlePostMessage(req,res);return;
   }
   if(req.method!=='POST'){res.writeHead(405).end();return;}
   let body='';for await(const chunk of req)body+=chunk;
   const t=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});const s=makeServer();
   res.on('close',()=>{t.close().catch(()=>{});s.close().catch(()=>{});});await s.connect(t);await t.handleRequest(req,res,JSON.parse(body));
  }catch{if(!res.headersSent)res.writeHead(500);res.end();}
 });http.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:http.address().port})+'\n'));
}else await makeServer().connect(new StdioServerTransport());
