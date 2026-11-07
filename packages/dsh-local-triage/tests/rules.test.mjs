import assert from 'node:assert/strict'
import { createHarness } from './_harness.mjs'
import { ruleTier, ruleCoverage } from '../lib/rules.mjs'
import { GOLDEN } from './golden.mjs'

const h = createHarness('rules.test')

h.check('空文本不判档', () => {
  assert.equal(ruleTier({ text: '   ' }).tier, null)
})

h.check('确认类短句判 local', () => {
  for (const text of ['好', '好的', '谢谢', '收到', 'OK', '在吗', '晚安']) {
    assert.equal(ruleTier({ text }).tier, 'local', `${text} 应判 local`)
  }
})

h.check('重构/排查判 frontier', () => {
  assert.equal(ruleTier({ text: '帮我重构一下这个模块' }).tier, 'frontier')
  assert.equal(ruleTier({ text: '排查一下为什么启动失败' }).tier, 'frontier')
})

h.check('翻译/格式/改名判 cheap', () => {
  const cases = [
    ['翻译一下这段话', 'cheap'],
    ['把 yaml 转成 json', 'cheap'],
    ['改个名字叫 fetchUser', 'cheap'],
    ['怎么配置 keep_alive', 'cheap'],
  ]
  for (const [text, want] of cases) {
    assert.equal(ruleTier({ text }).tier, want, `${text} 应判 ${want}`)
  }
})

h.check('带附件直接 frontier', () => {
  assert.equal(ruleTier({ text: '看看这个', attachments: 1 }).tier, 'frontier')
})

h.check('长对话直接 frontier', () => {
  assert.equal(ruleTier({ text: '继续', turns: 6 }).tier, 'frontier')
})

h.check('超长文本直接 frontier', () => {
  assert.equal(ruleTier({ text: '啊'.repeat(1201) }).tier, 'frontier')
})

h.check('工具过多直接 frontier', () => {
  assert.equal(ruleTier({ text: '都用一遍', tools: Array(8).fill('t') }).tier, 'frontier')
})

h.check('无关键词的中等请求应返回 null（交给本地模型）', () => {
  // 这一条是安全阀：规则不能瞎猜，判不了就必须让位
  assert.equal(ruleTier({ text: '把数据库连接池从 10 调到 50 会有什么影响' }).tier, null)
})

h.check('local 规则不会误吞普通短句', () => {
  // "嗯" 是 local，但 "嗯这个怎么改" 不应该是
  assert.notEqual(ruleTier({ text: '嗯这个怎么改' }).tier, 'local')
})

h.check('指代型提问不能被判 local（实拦过 4B 的 0.95 误判）', () => {
  const cases = [
    '这个函数是干什么的',
    '这段代码有啥问题',
    '上面那个配置在哪',
    '刚才说的那个文件呢',
  ]
  for (const text of cases) {
    assert.notEqual(ruleTier({ text }).tier, 'local', `${text} 不应判 local`)
  }
})

h.check('正则事故回归：数字 5000 不能被当成 HTTP 500', () => {
  assert.notEqual(ruleTier({ text: '上限提高到5000token' }).tier, 'frontier')
})

h.check('正则事故回归：文件名里的 design 不能触发 frontier', () => {
  assert.notEqual(ruleTier({ text: 'group-mind-tech-design-v1.md中本地视觉模型和OCR的区别' }).tier, 'frontier')
})

h.check('"方案是什么" 是查询不是设计，不该升 frontier', () => {
  assert.notEqual(ruleTier({ text: '我们之前定的微心跳方案是什么？' }).tier, 'frontier')
})

h.check('回归集规则覆盖率在合理区间', () => {
  const cov = ruleCoverage(GOLDEN.map((c) => ({ text: c.text, turns: c.turns, tools: c.tools, attachments: c.attachments })))
  assert.ok(cov.coverage >= 0.6, `规则覆盖率过低：${cov.coverage}`)
  assert.ok(cov.coverage <= 0.95, `规则覆盖率过高，说明样本太容易：${cov.coverage}`)
})

h.finish()
