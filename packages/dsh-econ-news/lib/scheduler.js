/**
 * 调度：宿主启动后延迟一次，检查「今天采过没」，没采就后台跑。
 *
 * 纪律（工作区规则）：
 *   · 不往任何会话注入消息 —— 采集过程只写磁盘与插件日志
 *   · 每天一次；失败 60s 后重试一次，仍失败就等手动或下次启动
 *   · 定时器必须能停（插件禁用/卸载时清掉），不能在进程里留僵尸
 */
import { todayString } from './collect.js';

export function createScheduler(options = {}) {
  const { config, store, run, log = () => {} } = options;
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
  const retryDelayMs = Number(options.retryDelayMs) > 0 ? Number(options.retryDelayMs) : 60000;

  let handle = null;
  let stopped = false;
  let running = false;

  async function attempt(date, isRetry) {
    if (stopped || running) return;
    running = true;
    try {
      const result = await run({ date, force: false });
      log(`[scheduler] collect ${date} → ${result?.skipped ? 'skipped:' + result.reason : 'done items=' + (result?.totals?.items ?? 0)}`);
    } catch (error) {
      const message = String((error && error.message) || error);
      log(`[scheduler] collect ${date} failed: ${message}`);
      store.writeState({ lastResult: 'error', lastError: message, retryCount: isRetry ? 1 : 0 });
      if (!isRetry) {
        handle = setTimer(() => attempt(date, true), retryDelayMs);
        return;
      }
    } finally {
      running = false;
    }
  }

  function tick() {
    if (stopped) return;
    const date = todayString();
    const state = store.readState();
    if (state.lastRunDate === date && state.lastResult === 'ok') {
      log(`[scheduler] ${date} 已采过，跳过`);
      return;
    }
    if (state.lastRunDate === date && state.lastResult === 'error' && Number(state.retryCount || 0) >= 1) {
      log(`[scheduler] ${date} 今日已失败并重试过一次，等手动 econ_news_collect 或下次启动`);
      return;
    }
    attempt(date, false);
  }

  function start() {
    if (config.autoCollect === false) {
      log('[scheduler] autoCollect=false，不排自动采集');
      return;
    }
    stopped = false;
    const delay = Number(config.autoDelayMs) > 0 ? Number(config.autoDelayMs) : 20000;
    handle = setTimer(tick, delay);
    log(`[scheduler] ${Math.round(delay / 1000)}s 后检查当日采集`);
  }

  function stop() {
    stopped = true;
    if (handle) {
      try {
        clearTimer(handle);
      } catch {
        // 清不掉也不影响插件卸载
      }
      handle = null;
    }
  }

  return { start, stop, tick };
}
