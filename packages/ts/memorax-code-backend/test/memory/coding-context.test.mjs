import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCodingSearchContext } from '../../dist/memory/coding-context.js';
import { normalizeCodingSessionTurn } from '../../dist/coding-sessions/coding-turn.js';
import { invokeMemoraxMemoryProvider } from '../../dist/provider/memorax/adapter.js';
import { retrieveAutomaticMemoryContext } from '../../dist/memory/automatic-retrieval.js';
import { memoraxConfigFromEnv } from '../../dist/provider/memorax/config.js';

const contract = JSON.parse(await readFile(new URL('../fixtures/helpful-contract.json', import.meta.url),'utf8'));
const env = {
  MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED:'true',
  MEMORAX_CODE_MEMORAX_ENDPOINT:'http://memorax.test',
  MEMORAX_CODE_MEMORAX_API_KEY:'fixture-key',
  MEMORAX_CODE_MEMORAX_USER_ID:'fixture-user',
};
const scope={schemaVersion:'workspace-memory-scope.v1',baseUserId:'fixture-user',effectiveUserId:'fixture-user@fixture',
  repositoryKey:'fixture',repositorySlug:'fixture',repositoryName:'fixture',identitySource:'origin-remote',scopeKind:'git-repository',boundWorkspaceRoot:'/fixture'};
function records(client) {
  if (client==='codex') return [
    {type:'session_meta',payload:{id:'session-contract',source:'cli'}},
    {type:'event_msg',payload:{type:'task_started',turn_id:'turn-7'}},
    {type:'event_msg',payload:{type:'user_message',message:'Run tests.'}},
  ];
  return [{type:'user',sessionId:'session-contract',promptId:'turn-7',userType:'external',
    isSidechain:false,message:{role:'user',content:'Run tests.'}}];
}
async function fixture(t, client='codex', transform=x=>x) {
  const dir=await mkdtemp(join(tmpdir(),'helpful-context-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const transcriptPath=join(dir,'native.jsonl');
  await writeFile(transcriptPath,transform(records(client)).map(x=>JSON.stringify(x)).join('\n')+'\n');
  return {schemaVersion:'1',client,sessionId:'session-contract',turnId:'turn-7',transcriptPath,contextOrigin:'codex-hook-body',capturedAt:new Date().toISOString()};
}
for (const client of ['codex','claude']) {
  test(`${client} exact native identity supplies Search and Turn correlation`,async t=>{
    const trace=await fixture(t,client);
    const context=await resolveCodingSearchContext(trace);
    assert.deepEqual(context,{...contract.coding_context,client:client==='claude'?'claude-code':'codex'});
    assert.equal(await resolveCodingSearchContext({...trace,sessionId:'other'}),undefined);
    assert.equal(await resolveCodingSearchContext({...trace,turnId:'other'}),undefined);
  });
}
test('coding context omits transcripts outside its byte or time budget',async t=>{
  const trace=await fixture(t);
  assert.equal(await resolveCodingSearchContext(trace,{maxTranscriptBytes:1,timeoutMs:250}),undefined);
  const slowTrace=await fixture(t,'codex',xs=>{
    xs[2].payload.message='x'.repeat(8*1024*1024);
    return xs;
  });
  assert.equal(await resolveCodingSearchContext(slowTrace,{maxTranscriptBytes:16*1024*1024,timeoutMs:1}),undefined);
});
test('Codex current native response_item user message supplies Search correlation', async t => {
  const trace = await fixture(t, 'codex', () => [
    {type:'session_meta',payload:{id:'session-contract',source:'cli'}},
    {type:'turn_context',payload:{turn_id:'turn-7'}},
    {type:'response_item',payload:{
      type:'message',
      role:'user',
      content:[{type:'input_text',text:'Run tests.'}],
      internal_chat_message_metadata_passthrough:{turn_id:'turn-7'},
    }},
  ]);
  assert.deepEqual(await resolveCodingSearchContext(trace), {
    ...contract.coding_context,
    client:'codex',
  });
});
test('Codex subagent and unknown source never infer main',async t=>{
  for(const source of [{subagent:{thread_spawn:{}}},undefined]) {
    const trace=await fixture(t,'codex',xs=>{xs[0].payload.source=source;return xs;});
    assert.equal(await resolveCodingSearchContext(trace),undefined);
  }
});
test('Claude sidechain and system prompts never infer end_user',async t=>{
  for(const extra of [{isSidechain:true},{isMeta:true},{promptSource:'system'},{userType:'internal'}]) {
    const trace=await fixture(t,'claude',xs=>[{...xs[0],...extra}]);
    assert.equal(await resolveCodingSearchContext(trace),undefined);
  }
});
test('automatic Search sends only normalized coding_context, never native paths',async t=>{
  const trace=await fixture(t);
  const requests=[];
  await retrieveAutomaticMemoryContext({env,query:'Run tests.',traceContext:trace,
    repositoryMemory:{ok:true,memory:{config:memoraxConfigFromEnv(env).config,scope}},
    fetchImpl:async (_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({data:{task_id:'server-id',data:[]}}),{status:200});},
  });
  assert.deepEqual(requests[0].coding_context,contract.coding_context);
  assert.equal(JSON.stringify(requests[0]).includes(trace.transcriptPath),false);
  assert.equal(requests[0].search_id,undefined);
});
test('automatic Search continues without correlation when the transcript is oversized',async t=>{
  const trace=await fixture(t);
  await truncate(trace.transcriptPath,16*1024*1024+1);
  const requests=[];
  await retrieveAutomaticMemoryContext({env,query:'Run tests.',traceContext:trace,
    repositoryMemory:{ok:true,memory:{config:memoraxConfigFromEnv(env).config,scope}},
    fetchImpl:async (_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({data:{task_id:'server-id',data:[]}}),{status:200});},
  });
  assert.equal(requests.length,1);
  assert.equal(requests[0].coding_context,undefined);
});
test('provider rejects untrusted request-context correlation by omission',async ()=>{
  const requests=[];
  await invokeMemoraxMemoryProvider({sessionId:'s',prompt:'tests'},
    {operation:'query',query:'tests',context:{coding_context:contract.coding_context}},
    {env,repositoryScope:scope,fetchImpl:async (_url,init)=>{requests.push(JSON.parse(init.body));return new Response('{}',{status:200});}});
  assert.equal(requests[0].coding_context,undefined);
});
test('shared wire fixture matches normalized Turn metadata',()=>{
  const turn=contract.coding_turns[0];
  const normalized=normalizeCodingSessionTurn({client:turn.client,sessionId:turn.session_id,turnId:turn.turn_id,
    turnIndex:turn.turn_index,outcome:'completed',closedAt:turn.closed_at,agentRole:'main',promptOrigin:'end_user',events:turn.events});
  assert.equal(normalized.agent_role,'main');assert.equal(normalized.prompt_origin,'end_user');
  assert.equal(normalized.turn_id,contract.coding_context.turn_id);
  assert.equal(normalized.turn_index,7);
});

test('CLI Search uses the exact operational Turn even when trace capture is disabled',async t=>{
  const { runMemoryCli }=await import('../../dist/memory/cli.js');
  const { writeCurrentCodexTurn }=await import('../../dist/trace/store.js');
  const trace=await fixture(t);
  const dir=join(trace.transcriptPath,'..');
  const home=join(dir,'home');
  const cliEnv={...env,CODEX_THREAD_ID:trace.sessionId,MEMORAX_CODE_HOME:home,MEMORAX_CODE_CODEX_TRACE_ENABLED:'false'};
  const current={...trace,cwd:dir,workspaceKind:'projectless'};
  await writeCurrentCodexTurn(current,{memoraxCodeHome:home,env:cliEnv});
  const requests=[];
  const result=await runMemoryCli(['search','--query','tests'],{cwd:dir,env:cliEnv,
    fetchImpl:async (_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({success:true,data:{data:[],task_id:'server-id'}}),{status:200});}});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(requests[0].coding_context,contract.coding_context);
});
