/**
 * 发布包脱敏：真实配置（QQ 号 / 群号）只放用户目录，仓库只留模板。
 * 覆盖：本地覆盖文件深合并、模板占位、package.json 打包清单、路径基准。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, configPaths } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.dirname(HERE)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-'))

try {
  // 1) 本地覆盖文件生效 + 深合并（只写少数字段，不丢默认值）
  fs.mkdirSync(path.join(temp, 'dafeiyu'), { recursive: true })
  fs.writeFileSync(
    path.join(temp, 'dafeiyu', 'qq.json'),
    JSON.stringify({ ownerId: '42', groups: ['10086'], tts: { scene: 'night' } }),
    'utf8',
  )
  const merged = loadConfig(temp)
  assert.equal(merged.ownerId, '42')
  assert.deepEqual(merged.groups, ['10086'])
  assert.equal(merged.tts.scene, 'night')
  assert.equal(merged.tts.url, 'http://127.0.0.1:9882', '深合并应保留默认 tts.url')
  assert.equal(merged.local.model, 'qwen3:4b', '深合并应保留默认 local.model')

  // 2) 仓库模板不含真实 QQ 号/群号，ownerId 为空
  const example = JSON.parse(fs.readFileSync(path.join(PKG, 'config.example.json'), 'utf8'))
  assert.equal(example.ownerId, '')
  assert.deepEqual(example.groups, [])
  const text = JSON.stringify(example)
  for (const secret of ['1000000001', '2000000001', '2000000002']) {
    assert.ok(!text.includes(secret), `config.example.json 泄漏 ${secret}`)
  }

  // 3) 发布包清单不再包含 config.json，真实配置在用户目录
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'))
  assert.ok(!pkg.files.includes('config.json'), 'package.json files 不应包含 config.json')
  assert.ok(pkg.files.includes('config.example.json'), 'package.json files 应包含 config.example.json')
  assert.ok(!fs.existsSync(path.join(PKG, 'config.json')), '仓库不应保留真实 config.json')

  // 4) 路径按 DSH_HOME 基准解析
  assert.equal(configPaths(temp).local, path.join(temp, 'dafeiyu', 'qq.json'))
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}

console.log('qq config load: ok')
