import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCodingSearchContext } from '../../dist/memory/coding-context.js';
import { prepareCodingSessionTurn } from '../../dist/coding-sessions/coding-turn.js';
import { invokeMemoraxMemoryProvider } from '../../dist/provider/memorax/adapter.js';
import { retrieveAutomaticMemoryContext } from '../../dist/memory/automatic-retrieval.js';
import { memoraxConfigFromEnv } from '../../dist/provider/memorax/config.js';
import { createHash } from 'node:crypto';

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
      internal_chat_message_metadata_passthrough:{turn_id:'turn-7',prompt_origin:'end_user'},
    }},
  ]);
  assert.deepEqual(await resolveCodingSearchContext(trace), {
    ...contract.coding_context,
    client:'codex',
  });
});
test('Codex independent sessions register regardless of launch source without inventing provenance',async t=>{
  for(const [source, role] of [[{subagent:{thread_spawn:{}}},'subagent'],[undefined,undefined],['exec','main']]) {
    const trace=await fixture(t,'codex',xs=>{xs[0].payload.source=source;return xs;});
    const context=await resolveCodingSearchContext(trace);
    assert.equal(context.turn_id,'turn-7');
    assert.equal(context.agent_role,role);
  }
});
test('Claude independent sidechain, system and unknown origin prompts register truthfully',async t=>{
  for(const [extra, role, origin] of [
    [{isSidechain:true},'subagent','end_user'],
    [{promptSource:'system'},'main','system'],
    [{userType:'internal'},'main',undefined],
    [{userType:undefined,isSidechain:undefined},undefined,undefined],
  ]) {
    const trace=await fixture(t,'claude',xs=>[{...xs[0],...extra}]);
    const context=await resolveCodingSearchContext(trace);
    assert.equal(context.turn_id,'turn-7');
    assert.equal(context.agent_role,role);
    assert.equal(context.prompt_origin,origin);
  }
});
test('Claude notifications, meta, compact summaries and tool results are not new prompts',async t=>{
  for(const extra of [{isMeta:true},{isCompactSummary:true},{isVisibleInTranscriptOnly:true},
    {origin:{kind:'task-notification'}},
    {message:{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'output'}]}},
    {message:{role:'user',content:[{type:'text',text:'Tool output follows'},
      {type:'tool_result',tool_use_id:'call',content:'output'}]}}]) {
    const trace=await fixture(t,'claude',xs=>[{...xs[0],...extra}]);
    assert.equal(await resolveCodingSearchContext(trace),undefined);
  }
});
test('Claude parent session cannot register an embedded sidechain as its own prompt',async t=>{
  const trace=await fixture(t,'claude',xs=>[
    {...xs[0],promptId:'parent-prompt'},
    {...xs[0],isSidechain:true},
  ]);
  assert.equal(await resolveCodingSearchContext(trace),undefined);
});
test('Codex current item_completed message uses exact identity without requiring origin',async t=>{
  const {codexSessionTurnIndexFromJsonLines}=await import('../../dist/clients/codex/session-turn-index.js');
  const native=[
    {type:'session_meta',payload:{id:'session-contract',source:'vscode'}},
    {type:'event_msg',payload:{type:'task_started',turn_id:'turn-7'}},
    {type:'event_msg',payload:{type:'item_completed',thread_id:'session-contract',turn_id:'turn-7',
      item:{type:'UserMessage',id:'user-id',content:[{type:'text',text:'Run tests.'}]}}},
  ];
  const trace=await fixture(t,'codex',()=>native);
  assert.deepEqual(await resolveCodingSearchContext(trace),{
    client:'codex',session_id:'session-contract',turn_id:'turn-7',agent_role:'main',
  });
  const text=[...native,native[2]].map(x=>JSON.stringify(x)).join('\n')+'\n';
  assert.deepEqual(codexSessionTurnIndexFromJsonLines(text,{sessionId:trace.sessionId,turnId:trace.turnId}),
    {ok:true,sessionTurnIndex:1});
  for(const changes of [{thread_id:'wrong'},{turn_id:'wrong'}]) {
    const broken=[...native.slice(0,2),{...native[2],payload:{...native[2].payload,...changes}}];
    await writeFile(trace.transcriptPath,broken.map(x=>JSON.stringify(x)).join('\n')+'\n');
    assert.equal(await resolveCodingSearchContext(trace),undefined);
  }
});
test('Codex Search correlation ignores internal turn IDs and keeps the outer identity',async t=>{
  const trace=await fixture(t,'codex',xs=>[
    ...xs,
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Run tests.'}],
      internal_chat_message_metadata_passthrough:{turn_id:'wrong'}}},
  ]);
  assert.deepEqual(await resolveCodingSearchContext(trace), { ...contract.coding_context, client: 'codex' });
});
test('Codex response without origin can register, and explicit system origin is retained',async t=>{
  for(const origin of [undefined,'system']) {
    const trace=await fixture(t,'codex',xs=>[...xs.slice(0,2),
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Run tests.'}],
        internal_chat_message_metadata_passthrough:{turn_id:'internal-turn',prompt_origin:origin}}}]);
    const context=await resolveCodingSearchContext(trace);
    assert.equal(context.turn_id,'turn-7');
    assert.equal(context.prompt_origin,origin);
  }
});
test('Codex Helpful uses outer identity while writeback rejects conflicting user metadata', async t => {
  const { codexSessionTurnIndexFromJsonLines } = await import('../../dist/clients/codex/session-turn-index.js');
  const { codexRolloutTurnFromJsonLines, codexCodingSessionTurnFromJsonLines } =
    await import('../../dist/clients/codex/rollout-turn.js');
  for (const key of ['turn_id', 'turnId']) {
    const trace = await fixture(t, 'codex', xs => [
      ...xs.slice(0, 2),
      { type: 'turn_context', payload: { turn_id: 'turn-7' } },
      { type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'Run tests.' }],
        internal_chat_message_metadata_passthrough: { [key]: 'internal-user-turn' } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Tests passed.' }],
        internal_chat_message_metadata_passthrough: { [key]: 'internal-answer-turn' } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-7' } },
    ]);
    assert.deepEqual(await resolveCodingSearchContext(trace),
      { client: 'codex', session_id: 'session-contract', turn_id: 'turn-7', agent_role: 'main' });
    const transcript = await readFile(trace.transcriptPath, 'utf8');
    const input = { sessionId: trace.sessionId, turnId: trace.turnId };
    assert.deepEqual(codexSessionTurnIndexFromJsonLines(transcript, input),
      { ok: true, sessionTurnIndex: 1 });
    for (const parser of [codexRolloutTurnFromJsonLines, codexCodingSessionTurnFromJsonLines]) {
      const result = parser(transcript, input);
      assert.deepEqual(result, { ok: false, reason: 'turn_metadata_mismatch' });
    }
  }
});
test('Codex Helpful internal IDs cannot supply missing or conflicting outer identity', async t => {
  const response = { type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'Run tests.' }],
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-7' } } };
  const base = records('codex').slice(0, 2);
  const cases = [
    [base[0], response],
    [base[1], response],
    [base[0], { type: 'event_msg', payload: { type: 'task_started', turn_id: 'other-turn' } }, response],
    [...base, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-7' } }, response],
    [...base, { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-7' } }, response],
    [...base, response, { type: 'session_meta', payload: { id: 'other-session' } }],
    [...base, response, { type: 'event_msg', payload: {
      type: 'user_message', turn_id: 'other-turn', message: 'Conflicting native prompt.' } }],
  ];
  for (const [index, native] of cases.entries()) {
    const trace = await fixture(t, 'codex', () => native);
    assert.equal(await resolveCodingSearchContext(trace), undefined, `outer identity case ${index}`);
  }
});
test('automatic Search sends only normalized coding_context, never native paths',async t=>{
  const trace=await fixture(t,'codex',xs=>[...xs.slice(0,2),
    {type:'response_item',payload:{type:'message',role:'user',
      content:[{type:'input_text',text:'Run tests.'}],
      internal_chat_message_metadata_passthrough:{turn_id:'internal-turn',prompt_origin:'end_user'}}}]);
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
  const normalized=prepareCodingSessionTurn({client:turn.client,sessionId:turn.session_id,turnId:turn.turn_id,
    turnIndex:turn.turn_index,outcome:'completed',closedAt:turn.closed_at,agent_role:'main',prompt_origin:'end_user',items:[
      {type:'message',role:'user',content:[{type:'input_text',text:'Run tests.'}]},
      {type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Done.'}]},
    ]});
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

for (const client of ['codebuddy', 'workbuddy']) {
  test(`${client} Search resolves the native message ID independently of provenance`, async t => {
    const trace = await fixture(t);
    const prompt = 'Run tests.';
    const hookId = `session-contract:0:${createHash('sha256').update(prompt).digest('hex')}`;
    const native = {id:'native-user',sessionId:trace.sessionId,type:'message',role:'user',
      content:[{type:'input_text',text:prompt}],agent_role:'main',prompt_origin:'end_user'};
    await writeFile(trace.transcriptPath, JSON.stringify(native)+'\n');
    const context = await resolveCodingSearchContext({...trace,client,turnId:hookId});
    assert.deepEqual(context,{client,session_id:trace.sessionId,turn_id:'native-user',agent_role:'main',prompt_origin:'end_user'});
    for (const changes of [{agent_role:undefined},{prompt_origin:undefined},{agent_role:'subagent'},{prompt_origin:'system'}]) {
      await writeFile(trace.transcriptPath, JSON.stringify({...native,...changes})+'\n');
      const result=await resolveCodingSearchContext({...trace,client,turnId:hookId});
      assert.equal(result.turn_id,'native-user');
      assert.equal(result.agent_role, {...native,...changes}.agent_role);
      assert.equal(result.prompt_origin, {...native,...changes}.prompt_origin);
    }
  });
}

test('OpenCode lifecycle provenance survives the current-turn record for explicit Search', async () => {
  const {traceContextFromOpenCodeHookBody,traceContextJson,traceContextFromCurrentTurnRecord} = await import('../../dist/trace/context.js');
  const trace = traceContextFromOpenCodeHookBody({sessionId:'session',userMessageId:'native-user',agentRole:'main',promptOrigin:'end_user',nativePromptVerified:true});
  const restored = traceContextFromCurrentTurnRecord(traceContextJson(trace));
  assert.deepEqual(await resolveCodingSearchContext(restored),{client:'opencode',session_id:'session',turn_id:'native-user',agent_role:'main',prompt_origin:'end_user'});
  assert.equal((await resolveCodingSearchContext({...restored,agentRole:undefined})).agent_role,undefined);
  assert.equal((await resolveCodingSearchContext({...restored,promptOrigin:'system',agentRole:'subagent'})).prompt_origin,'system');
  assert.equal(await resolveCodingSearchContext({...restored,nativePromptVerified:undefined}),undefined);
});

test('OpenCode native verification flag is validated at the versioned command boundary', async () => {
  const {parseTurnStartCommand} = await import('../../dist/memory/hook-command.js');
  const command={version:1,client:'opencode',sessionId:'session',userMessageId:'native-user',
    prompt:'Run tests.',cwd:'/fixture',nativePromptVerified:true};
  const parsed=parseTurnStartCommand(command);
  assert.equal(parsed.ok,true);
  assert.equal(parsed.command.nativePromptVerified,true);
  assert.equal(parseTurnStartCommand({...command,nativePromptVerified:'true'}).ok,false);
  assert.equal(parseTurnStartCommand({...command,client:'codex',turnId:'turn',transcriptPath:'/fixture/native.jsonl'}).ok,false);
});
