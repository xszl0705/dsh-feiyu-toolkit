import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'reflection-fail-'))
process.env.DSH_HOME=temp
const {runReflection}=await import('../index.js')
const key=Symbol.for('dsh-memory-unified.service')
globalThis[Symbol.for('dsh-dafeiyu-dialog.service')]={recent:()=>Array.from({length:2},()=>({at:new Date().toISOString(),text:'test'}))}
let calls=0
const ctx={get:()=>({stream:async function*(){calls++;await new Promise(r=>setTimeout(r,10));yield {type:'text',text:JSON.stringify({memories:[{text:'test memory',importance:0.9}]})}}})}
assert.equal((await runReflection(ctx)).reason,'memory-unavailable');assert.equal(calls,0)
globalThis[key]={remember:()=>({ok:false})}
assert.equal((await runReflection(ctx)).ok,false)
assert.equal(fs.existsSync(path.join(temp,'dafeiyu/reflections/last-run.json')),false)
globalThis[key]={remember:()=>({ok:true})}
const results=await Promise.all([runReflection(ctx),runReflection(ctx)])
assert.equal(results.filter(x=>x.ok).length,1)
assert.ok(results.some(x=>x.reason==='busy'))
assert.equal((await runReflection(ctx)).reason,'already-run')
assert.equal((await runReflection(ctx,{date:'../../bad'})).reason,'invalid-date')
fs.rmSync(temp,{recursive:true,force:true})
console.log('reflection failure, retry and single-flight passed')
