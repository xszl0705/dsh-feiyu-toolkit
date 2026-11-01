import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkProfile, installPlugin, instanceStatus, portOpen, stopInstance } from '../lib/playground.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'playground-'))
const backupRoot = path.join(temp, 'backups')

function seedProfile(name) {
  const dir = path.join(temp, 'profiles', name)
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: `dsh-profile-${name}`, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2),
    'utf8',
  )
  return dir
}

test('portOpen 对没人监听的端口返回 false', async () => {
  const open = await portOpen(59999, 300)
  assert.equal(open, false)
})

test('installPlugin 装 link 插件：备份 + deps + bundles + junction + 自检', () => {
  const dir = seedProfile('verifyx')
  const sourceDir = path.join(temp, 'fake-plugin')
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'index.js'), 'export const name = "fake"\n', 'utf8')

  const result = installPlugin({
    profile: 'verifyx',
    packageName: 'fake-plugin',
    sourceDir,
    config: { profilesRoot: path.join(temp, 'profiles'), backupRoot },
  })

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(fs.existsSync(path.join(result.backup, 'package.json')), '应该留备份')

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies['fake-plugin'], 'deps 里应该有')
  assert.ok(pkg.dsh.profile.bundles.includes('fake-plugin'), 'bundles 里应该有')
  assert.equal(result.checks.junctionReadable, true)
  assert.ok(result.checks.bundlesCount >= 2)
})

test('重复安装同一个插件不会重复加 bundles', () => {
  const sourceDir = path.join(temp, 'fake-plugin')
  installPlugin({
    profile: 'verifyx',
    packageName: 'fake-plugin',
    sourceDir,
    config: { profilesRoot: path.join(temp, 'profiles'), backupRoot },
  })
  const pkg = JSON.parse(fs.readFileSync(path.join(temp, 'profiles', 'verifyx', 'package.json'), 'utf8'))
  const count = pkg.dsh.profile.bundles.filter((b) => b === 'fake-plugin').length
  assert.equal(count, 1)
})

test('入口在 lib/ 下的包（main: lib/index.js）自检也通过', () => {
  const dir = seedProfile('verifyx2')
  const sourceDir = path.join(temp, 'lib-entry-plugin')
  fs.mkdirSync(path.join(sourceDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'lib-entry-plugin', main: 'lib/index.js' }), 'utf8')
  fs.writeFileSync(path.join(sourceDir, 'lib', 'index.js'), 'export const name = "lib-entry"\n', 'utf8')

  const result = installPlugin({
    profile: 'verifyx2',
    packageName: 'lib-entry-plugin',
    sourceDir,
    config: { profilesRoot: path.join(temp, 'profiles'), backupRoot },
  })

  // 2026-10-31：原来写死查 node_modules/<pkg>/index.js，装 auto-memory 时误报「安装失败」
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.checks.junctionReadable, true)
  assert.equal(result.checks.entry, 'lib/index.js')

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.ok(pkg.dsh.profile.bundles.includes('lib-entry-plugin'))
})

test('profile 不存在时明确报错，不猜', () => {
  const result = installPlugin({
    profile: 'nope',
    packageName: 'x',
    config: { profilesRoot: path.join(temp, 'profiles'), backupRoot },
  })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /不存在/)
})

test('instanceStatus 没 pid 时不崩，如实报端口状态', async () => {
  const status = await instanceStatus({ state: {}, config: { port: 59998, profilesRoot: path.join(temp, 'profiles') } })
  assert.equal(status.listening, false)
  // 没 pid 时字段直接不出现（schema 声明成 number，null 会被输出校验拒掉）
  assert.equal(status.pid, undefined)
  assert.equal(status.port, 59998)
})

test('stopInstance 没 pid 时返回失败，不误杀', () => {
  const result = stopInstance({ state: {} })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /pid/)
})

test('checkProfile 在 CLI 不存在时给出明确错误', () => {
  const result = checkProfile({ profile: 'verifyx', config: { exe: path.join(temp, 'no-such.exe'), cli: path.join(temp, 'no-such.js') } })
  assert.equal(result.ok, false)
  assert.ok(result.error)
})

test('清理', () => {
  fs.rmSync(temp, { recursive: true, force: true })
})
