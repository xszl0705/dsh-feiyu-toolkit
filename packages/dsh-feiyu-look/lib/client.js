/* dsh-feiyu-look — 浏览器半侧（手写 bundle，无构建）
 * 契约：window.__ModuleLoader__.load({ id, factory(require) })；factory 返回 { apply, inject }。
 * 只依赖基座里的 react；不引 primitives，避免版本漂移。
 *
 * 位置：挂在 shell.overlay（浮层），自己用 fixed 定位到右上角。
 * 原来的 conversation.input.dock 是猜的名字，宿主里没有这个 slot——
 * 真实存在过的只有 shell.overlay / settings.section / sidebar.panellist 这几个。
 */
window.__ModuleLoader__.load({
  id: "dsh-feiyu-look",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require("react")
    const h = React.createElement

    const ROUTE = "/dsh-feiyu-look/state"
    const REFRESH_MS = 30000

    // 右上角浮层：不挡鼠标、不挡输入框
    // top: 40 是为了避开窗口标题栏和右上角那三个窗口按钮——放 10px 时会压住标题栏，
    // 第五个 chip 直接被挤到窗口按钮底下看不见（2026-10-31 截图确认过）。
    const wrapStyle = {
      position: "fixed",
      top: "40px",
      right: "16px",
      zIndex: 20,
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "4px 7px",
      borderRadius: "10px",
      fontSize: "12px",
      lineHeight: "16px",
      color: "inherit",
      background: "rgba(127,127,127,0.16)",
      border: "1px solid rgba(127,127,127,0.22)",
      boxShadow: "0 1px 6px rgba(0,0,0,0.10)",
      userSelect: "none",
      flexWrap: "wrap",
      maxWidth: "70vw",
      pointerEvents: "none",
    }

    const chipStyle = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      padding: "1px 8px",
      borderRadius: "999px",
      border: "1px solid rgba(127,127,127,0.34)",
      background: "rgba(127,127,127,0.14)",
      whiteSpace: "nowrap",
    }

    function chip(key, label, value, title) {
      return h(
        "span",
        { key, style: chipStyle, title: title || "" },
        h("span", { style: { opacity: 0.65 } }, label),
        h("span", null, value),
      )
    }

    function StatusStrip() {
      const [state, setState] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        let timer = 0

        const load = () => {
          let p
          try {
            p = fetch(ROUTE, { cache: "no-store" })
          } catch {
            return
          }
          p.then(function (r) { return r.ok ? r.json() : null })
            .then(function (data) { if (alive && data && !data.error) setState(data) })
            .catch(function () {})
        }

        load()
        timer = setInterval(load, REFRESH_MS)
        return function () {
          alive = false
          clearInterval(timer)
        }
      }, [])

      if (!state) return null

      const parts = []
      if (state.mood && typeof state.mood.value === "number") {
        parts.push(chip("mood", "心情", String(state.mood.value), state.mood.reason || ""))
      }
      if (state.memory) parts.push(chip("memory", "记忆", String(state.memory.items), "跨会话记忆条数"))
      if (state.knowledge) parts.push(chip("know", "知识", String(state.knowledge.items), "知识库条目数"))
      if (typeof state.skills === "number") parts.push(chip("skills", "技能", String(state.skills), "已装技能数"))
      if (state.pet) parts.push(chip("pet", "桌宠", state.pet.running ? "在" : "停", state.pet.running ? "pid " + state.pet.pid : "未运行"))

      if (parts.length === 0) return null
      return h("div", { style: wrapStyle }, parts)
    }

    const inject = ["slots"]

    function apply(ctx) {
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: "feiyu-look", order: 30 },
          StatusStrip,
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
