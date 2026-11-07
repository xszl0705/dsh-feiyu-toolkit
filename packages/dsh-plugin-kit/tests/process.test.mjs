import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyProcess, isAlive, listOwnProcesses, portOpen, stopOwnProcess } from '../lib/process.js'

test('classifyProcess 认得三类自有进程', () => {
  assert.equal(classifyProcess({ name: 'pythonw.exe', cmd: 'C:\\x\\pythonw.exe run_pet.py' }), 'pet')
  assert.equal(classifyProcess({ name: 'python.exe', cmd: 'C:\\x\\python.exe run_pet.py' }), 'pet')
  assert.equal(classifyProcess({ name: 'DeepSeek Harness.exe', cmd: 'C:\\tools\\x.exe x mind-loop.mjs' }), 'mindLoop')
  assert.equal(classifyProcess({ name: 'DeepSeek Harness.exe', cmd: 'C:\\tools\\x.exe --expose-internals cli.js --profile verifyx' }), 'verifyx')
  assert.equal(classifyProcess({ name: 'DeepSeek Harness.exe', cmd: 'C:\\tools\\x.exe --profile=verifyx' }), 'verifyx')
})

test('classifyProcess 不认宿主与无关进程', () => {
  assert.equal(classifyProcess({ name: 'DeepSeek Harness.exe', cmd: 'C:\\tools\\x.exe --profile desktop' }), null)
  // 路径里恰好出现 verifyx 但命令行没有 --profile 的不算
  assert.equal(classifyProcess({ name: 'node.exe', cmd: 'C:\\x\\profiles\\verifyx\\node_modules\\a.js' }), null)
  assert.equal(classifyProcess({ name: 'python.exe', cmd: 'C:\\x\\other.py' }), null)
  assert.equal(classifyProcess({}), null)
})

test('listOwnProcesses 分组并跳过不认识的行', async () => {
  const rows = [
    { ProcessId: 11, Name: 'pythonw.exe', CommandLine: 'x run_pet.py' },
    { ProcessId: 22, Name: 'DeepSeek Harness.exe', CommandLine: 'x mind-loop.mjs' },
    { ProcessId: 33, Name: 'DeepSeek Harness.exe', CommandLine: 'x --profile verifyx' },
    { ProcessId: 44, Name: 'explorer.exe', CommandLine: 'C:\\Windows\\explorer.exe' },
  ]
  const res = await listOwnProcesses({ run: async () => ({ ok: true, out: JSON.stringify(rows) }) })
  assert.deepEqual(res.pet.map((p) => p.pid), [11])
  assert.deepEqual(res.mindLoop.map((p) => p.pid), [22])
  assert.deepEqual(res.verifyx.map((p) => p.pid), [33])
})

test('listOwnProcesses 查不到时返回空分组', async () => {
  const res = await listOwnProcesses({ run: async () => ({ ok: false, out: '' }) })
  assert.deepEqual(res, { pet: [], mindLoop: [], verifyx: [] })
})

test('stopOwnProcess 拒绝不在自有清单里的 pid（不调 kill）', async () => {
  let killed = false
  const res = await stopOwnProcess('pet', [999], {
    list: async () => ({ pet: [], mindLoop: [], verifyx: [] }),
    kill: async () => {
      killed = true
    },
  })
  assert.equal(res.ok, false)
  assert.deepEqual(res.rejected, [999])
  assert.equal(killed, false)
})

test('stopOwnProcess 只停清单内的 pid，并复核存活', async () => {
  let killed = []
  const res = await stopOwnProcess('pet', [11, 99], {
    list: async () => ({ pet: [{ pid: 11 }], mindLoop: [], verifyx: [] }),
    kill: async (pids) => {
      killed = pids
      return { ok: true }
    },
    wait: async () => {},
    alive: () => false,
  })
  assert.equal(res.ok, true)
  assert.deepEqual(killed, [11])
  assert.deepEqual(res.rejected, [99])
})

test('stopOwnProcess 杀掉后仍存活要报失败', async () => {
  const res = await stopOwnProcess('pet', [11], {
    list: async () => ({ pet: [{ pid: 11 }], mindLoop: [], verifyx: [] }),
    kill: async () => ({ ok: true }),
    wait: async () => {},
    alive: () => true,
  })
  assert.equal(res.ok, false)
  assert.deepEqual(res.alive, [11])
})

test('stopOwnProcess 空列表直接成功', async () => {
  const res = await stopOwnProcess('pet', [])
  assert.deepEqual(res, { ok: true, stopped: [], rejected: [] })
})

test('isAlive 对当前进程为 true，对不存在的 pid 为 false', () => {
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(999999), false)
  assert.equal(isAlive(0), false)
})

test('portOpen 对没人监听的端口返回 false', async () => {
  assert.equal(await portOpen(59999, { timeoutMs: 300 }), false)
})
