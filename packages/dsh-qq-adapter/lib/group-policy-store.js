/**
 * 群策略状态持久化：每群一个 JSON。
 * 只存策略状态，不存消息正文。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteJson } from 'dsh-plugin-kit/atomic-write'

const BASE = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIR = path.join(BASE, 'dafeiyu', 'group-policy')

function fileOf(groupId) {
  return path.join(DIR, String(groupId || 'unknown').replace(/[^\w-]/g, '_') + '.json')
}

export function loadPolicyState(groupId, createState) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(groupId), 'utf8'))
    return raw && typeof raw === 'object' ? raw : createState()
  } catch {
    return createState()
  }
}

export function savePolicyState(groupId, state) {
  try {
    atomicWriteJson(fileOf(groupId), state)
  } catch {
    // 策略状态写失败不影响主流程
  }
}
