/** 场景卡与镜头、选择回响。冲突必须拆成"双方各要什么"，代码才能检查互斥。 */
import { nextId, readState, writeState } from './store.js'

export function newScene(name, input, config) {
  const scenes = readState(name, 'scenes', config)
  if (!scenes) throw new Error('项目不存在：' + name)
  const scene = {
    id: nextId('sc'),
    title: String(input.title || '未命名场景'),
    plotline: Array.isArray(input.plotline) && input.plotline.length ? input.plotline : ['main'],
    place: String(input.place || ''),
    time: String(input.time || ''),
    cast: Array.isArray(input.cast) ? input.cast : [],
    goal: null, // 留给玩家
    conflict: {
      a: { who: String(input.aWho || ''), want: String(input.aWant || '') },
      b: { who: String(input.bWho || ''), want: String(input.bWant || '') },
    },
    disaster: String(input.disaster || ''),
    clues: Array.isArray(input.clues) ? input.clues.map((c) => String(c)).filter(Boolean) : [],
    outcome: null,
    stateDelta: [],
    createdAt: new Date().toISOString(),
  }
  scenes.push(scene)
  writeState(name, 'scenes', scenes, config)
  return scene
}

/** 确定性检查：字段齐不齐、线索够不够、冲突双方的目标是否不同。 */
export function checkScene(name, id, config) {
  const scenes = readState(name, 'scenes', config) || []
  const scene = id ? scenes.find((s) => s.id === id) : scenes[scenes.length - 1]
  if (!scene) throw new Error('没有这个场景')
  const issues = []
  const c = scene.conflict || {}
  if (!c.a?.who || !c.a?.want) issues.push({ level: 'blocker', msg: '冲突 A 方缺 who 或 want' })
  if (!c.b?.who || !c.b?.want) issues.push({ level: 'blocker', msg: '冲突 B 方缺 who 或 want' })
  if (c.a?.want && c.b?.want && c.a.want === c.b.want) issues.push({ level: 'blocker', msg: '双方要的是同一个东西——冲突不成立' })
  if (!scene.disaster) issues.push({ level: 'major', msg: '没写"更糟"（disaster）——失败只会变成"不行"' })
  if ((scene.clues || []).length < 3) issues.push({ level: 'major', msg: '线索只有 ' + (scene.clues || []).length + ' 条，至少三条' })
  if (!scene.place) issues.push({ level: 'minor', msg: '缺地点' })
  if (!scene.time) issues.push({ level: 'minor', msg: '缺时间' })
  return { id: scene.id, title: scene.title, ok: issues.filter((i) => i.level === 'blocker').length === 0, issues }
}

/** 镜头表：哪些在场角色这个场景还没"有戏"。 */
export function beamStatus(name, config) {
  const scenes = readState(name, 'scenes', config) || []
  const last = scenes[scenes.length - 1]
  if (!last) return { scene: null, idle: [], note: '还没有场景' }
  const beats = readState(name, 'beats', config) || []
  const acted = new Set(beats.filter((b) => b.at === last.id).map((b) => b.who))
  const idle = (last.cast || []).filter((who) => !acted.has(who))
  return { scene: last.id, title: last.title, cast: last.cast || [], acted: [...acted], idle, note: idle.length ? '下一帖给这几个人具体处境，别泛问「大家呢」' : '都有戏了' }
}

export function recordBeat(name, input, config) {
  const beats = readState(name, 'beats', config) || []
  const beat = {
    id: nextId('bt'),
    at: String(input.at || ''),
    who: String(input.who || ''),
    choice: String(input.choice || ''),
    changed: String(input.changed || ''),
    cost: String(input.cost || ''),
    at2: new Date().toISOString(),
  }
  if (!beat.who || !beat.choice) throw new Error('beat 需要 who 和 choice')
  beats.push(beat)
  writeState(name, 'beats', beats, config)
  return beat
}

/** 横切自检：把四层的问题一次扫出来。 */
export function checkAll(name, config) {
  const scenes = readState(name, 'scenes', config) || []
  const beats = readState(name, 'beats', config) || []
  const issues = []
  const noBeat = scenes.filter((s) => s.outcome && !beats.some((b) => b.at === s.id))
  if (noBeat.length) issues.push({ level: 'major', msg: noBeat.length + ' 个已结束的场景没有记录任何"选择改变了什么"——可能是假选择' })
  const noClues = scenes.filter((s) => !s.outcome && (s.clues || []).length < 3)
  if (noClues.length) issues.push({ level: 'major', msg: noClues.length + ' 个进行中的场景线索不足三条' })
  return { ok: issues.filter((i) => i.level === 'blocker').length === 0, issues, counts: { scenes: scenes.length, beats: beats.length } }
}
