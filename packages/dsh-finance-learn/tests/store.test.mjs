/**
 * 存储层测试：临时库跑，不碰真实学习数据。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FinanceStore } from '../lib/store.js'

const TMP_DB = path.join(os.tmpdir(), `finance-learn-test-${process.pid}.db`)

export function run() {
  const cases = []
  const add = (name, ok, actual, expected) => cases.push({ name, ok: Boolean(ok), actual, expected })

  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(TMP_DB + suffix, { force: true })
    } catch {
      // 清不掉就用新文件名，测试自己会失败并报出来
    }
  }

  const store = new FinanceStore(TMP_DB)
  try {
    // ---- 增
    const card = store.addCard({ title: '通胀', body: '物价总水平持续上涨，购买力下降。案例：CPI 同比连续三个月上行。', tags: '宏观,物价', source: 'test' })
    add('新增卡片有 id', Boolean(card?.id), card?.id, 'c_xxx')
    add('新增卡片标题', card?.title === '通胀', card?.title, '通胀')

    // ---- 重复添加同一内容应幂等（同 id）
    const again = store.addCard({ title: '通胀', body: card.body, tags: '宏观,物价' })
    add('同内容幂等同 id', again?.id === card.id, again?.id, card.id)

    // ---- 改
    const updated = store.updateCard(card.id, { tags: '宏观,物价,通胀' })
    add('更新标签', updated?.tags === '宏观,物价,通胀', updated?.tags, '宏观,物价,通胀')

    // ---- 查
    add('按 id 取回', store.getCard(card.id)?.title === '通胀', store.getCard(card.id)?.title, '通胀')
    add('列表包含新卡', store.listCards({ limit: 10 }).some((c) => c.id === card.id), true, true)

    // ---- 搜（FTS5 中文短语）
    const hits = store.searchCards('购买力')
    add('中文检索命中', hits.some((c) => c.id === card.id), hits.length, '>=1')
    const miss = store.searchCards('量子纠缠')
    add('无关检索不命中', miss.length === 0, miss.length, 0)

    // ---- 复习调度
    const base = new Date('2026-11-01T12:00:00Z')
    const g1 = store.gradeCard(card.id, 3, base)
    add('首次 Good 间隔 1 天', g1.interval === 1, g1.interval, 1)
    const g2 = store.gradeCard(card.id, 3, new Date(base.getTime() + 86400000))
    add('第二次 Good 间隔 6 天', g2.interval === 6, g2.interval, 6)

    // 现在没有到期卡（下次在 6 天后）
    const dueNow = store.dueCards(10, new Date(base.getTime() + 86400000))
    add('未到期不出现', dueNow.every((c) => c.id !== card.id), dueNow.length, 0)

    // 未来时间点到期
    const dueLater = store.dueCards(10, new Date(base.getTime() + 7 * 86400000))
    add('到期后出现', dueLater.some((c) => c.id === card.id), dueLater.length, '>=1')

    // 状态可读
    const state = store.reviewState(card.id)
    add('复习状态持久化', state?.reps === 2, state?.reps, 2)

    // ---- 统计
    const stats = store.reviewStats(new Date(base.getTime() + 7 * 86400000))
    add('统计 总数>=1', stats.total >= 1, stats.total, '>=1')
    add('统计 已学>=1', stats.learned >= 1, stats.learned, '>=1')

    // ---- 缓存
    store.cachePut('k', { hello: 1 })
    add('缓存命中', store.cacheGet('k', 60000)?.hello === 1, store.cacheGet('k', 60000)?.hello, 1)
    add('缓存过期不命中', store.cacheGet('k', 0) === null, store.cacheGet('k', 0), null)
    add('过期缓存仍可取回', store.cacheGetStale('k')?.value?.hello === 1, store.cacheGetStale('k')?.value?.hello, 1)

    // ---- 删
    add('删除成功', store.removeCard(card.id) === true, store.removeCard(card.id), true)
    add('删除后取不到', store.getCard(card.id) === null, store.getCard(card.id), null)
  } finally {
    store.close()
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(TMP_DB + suffix, { force: true })
      } catch {
        // 临时文件删不掉不影响结论
      }
    }
  }

  const failed = cases.filter((c) => !c.ok)
  return { ok: failed.length === 0, total: cases.length, failed: failed.length, cases }
}
