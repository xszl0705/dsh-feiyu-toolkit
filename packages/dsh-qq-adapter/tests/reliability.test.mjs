import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reliability-'))
process.env.DSH_HOME = dir
const { onFrame } = await import('../index.js')
const { askLLM } = await import('../lib/reply.js')

test('quality retries send once, aggregate usage, and deduplicate redelivery', async () => {
  const sent = [], stats = []; let calls = 0
  const runtime = { config: { ownerId: '100', allowPrivate: true, local: { enabled: false }, pauseFile: path.join(dir, 'pause') },
    identity:'test', approvals:{resolve:()=>null}, llm:()=>({stream:async function*(){
      calls += 1; yield {type:'text-delta',text:calls===1?'记不清':'最终答案'}
      yield {type:'usage',usage:{inputTokens:10,outputTokens:2}}
    }}), send:async x=>{sent.push(x.text);return {ok:true}},
    brain:{guard:()=>({blocked:false}),decideRoute:()=>({route:'big'}),classifyIntent:()=>({intent:'memory'}),
      buildContext:()=>({memory:[{text:'已知证据'}],recent:[]}),recordStats:x=>stats.push(x)}, }
  const st={seen:new Set(),history:new Map(),groupLastReply:new Map(),ignored:0,replied:0}
  const data=JSON.stringify({post_type:'message',message_type:'private',self_id:'200',user_id:'100',message_id:'id1',message:'上次计划是什么'})
  await Promise.all([onFrame(data,runtime,st),onFrame(data,runtime,st)])
  assert.deepEqual(sent,['最终答案']);assert.equal(calls,2)
  assert.equal(stats[0].promptTokens,20);assert.equal(stats[0].outTokens,4)
  assert.equal(st.frameQueues.size,0)
})

test('non-whitelisted groups do not reach knowledge ingestion', async () => {
  let ingested=0
  const st={seen:new Set(),ignored:0}
  await onFrame(JSON.stringify({post_type:'message',message_type:'group',self_id:'2',user_id:'1',group_id:'B',message_id:'group-1',message:'https://example.test/'}),
    {config:{groups:['A'],pauseFile:path.join(dir,'pause')},knowledge:{ingestLink:()=>{ingested++;return Promise.resolve()}}},st)
  assert.equal(ingested,0)
})

test('timeout cancels the host request and closes its iterator', async () => {
  let aborted=false,closed=false
  const llm={stream:({signal})=>({[Symbol.asyncIterator](){return this},next(){return new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true})
  })},async return(){closed=true;return {done:true}}})}
  await assert.rejects(askLLM(llm,'test',{timeoutMs:5}), /timeout/)
  assert.equal(aborted,true);assert.equal(closed,true)
})

test.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
