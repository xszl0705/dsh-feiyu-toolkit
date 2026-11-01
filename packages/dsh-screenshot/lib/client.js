/* dsh-screenshot — 浏览器半侧（手写 bundle，无构建）
 * 契约：window.__ModuleLoader__.load({ id, factory(require) })；factory 返回 { apply, inject }。
 *
 * 位置：挂在 `conversation.input.left`（list/session），也就是输入框左下角工具区、
 * 原生「+」按钮旁边。
 *
 * 流程：点按钮 → 宿主端点抓一张整屏 → 冻结画面盖满视口 → 拖拽框选 →
 * canvas 按框裁剪 → 把裁好的 PNG 塞进 composer 附件栏（不直接发送，用户补话再发）。
 *
 * 为什么先抓整屏再在浏览器里裁：屏幕坐标、窗口位置、DPI 缩放、多显示器换算
 * 每一步都可能偏几百像素；裁剪放在图片像素空间做就没有这个问题。
 * Enter / 双击 = 用整屏，Esc = 取消。
 */
window.__ModuleLoader__.load({
  id: "dsh-screenshot",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require("react")
    const h = React.createElement

    const ROUTE = "/dsh-screenshot/capture"
    const DELAY_MS = 3000
    const FETCH_TIMEOUT_MS = 30000
    const MIN_SELECTION = 6
    const STYLE_ID = "dsh-screenshot-button-style"

    const CSS = [
      // ---- 输入框里的按钮 ----
      ".dsh-shot-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;margin:0 2px;",
      "border-radius:999px;border:1px solid rgba(127,127,127,.30);background:rgba(127,127,127,.10);",
      "color:inherit;font-size:12px;line-height:1;cursor:pointer;user-select:none;white-space:nowrap;",
      "transition:background .12s ease,border-color .12s ease}",
      ".dsh-shot-btn:hover:not(:disabled){background:rgba(127,127,127,.22);border-color:rgba(127,127,127,.45)}",
      ".dsh-shot-btn:disabled{cursor:default;opacity:.55}",
      '.dsh-shot-btn[data-tone="ok"]{border-color:rgba(46,160,67,.55)}',
      '.dsh-shot-btn[data-tone="err"]{border-color:rgba(220,60,60,.55)}',
      ".dsh-shot-icon{width:13px;height:13px;display:block;flex:none}",
      // ---- 框选层 ----
      ".dsh-shot-picker{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.62);",
      "display:flex;align-items:center;justify-content:center;cursor:crosshair;user-select:none}",
      ".dsh-shot-picker-img{max-width:96vw;max-height:88vh;display:block;border-radius:6px;",
      "box-shadow:0 10px 44px rgba(0,0,0,.55);pointer-events:none}",
      ".dsh-shot-picker-box{position:fixed;display:none;pointer-events:none;z-index:2147483001;",
      "border:1.5px solid #4ea1ff;background:rgba(78,161,255,.16);box-sizing:border-box}",
      ".dsh-shot-picker-tip{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483002;",
      "background:rgba(16,16,16,.82);color:#fff;font-size:13px;line-height:1;padding:8px 14px;",
      "border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.35);white-space:nowrap}",
      ".dsh-shot-picker-size{position:fixed;z-index:2147483002;background:rgba(78,161,255,.92);color:#fff;",
      "font-size:11px;line-height:1;padding:3px 6px;border-radius:4px;pointer-events:none;display:none}",
    ].join("")

    function ensureStyle() {
      if (typeof document === "undefined" || !document.head) return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement("style")
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function CameraIcon() {
      return h(
        "svg",
        {
          className: "dsh-shot-icon",
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          "aria-hidden": "true",
        },
        h("path", { d: "M2 5.3h2.2l1.1-1.7h5.4l1.1 1.7H14v7.1H2z", strokeLinejoin: "round" }),
        h("circle", { cx: "8", cy: "8.8", r: "2.3" }),
      )
    }

    function shotName() {
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
      return "shot-" + stamp + ".png"
    }

    /** 调宿主端点抓一张整屏，返回 { blob, path }。 */
    async function captureOnce() {
      const controller = typeof AbortController === "function" ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : 0
      let response
      try {
        response = await fetch(ROUTE + "?t=" + Date.now(), {
          cache: "no-store",
          signal: controller ? controller.signal : undefined,
        })
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (!response.ok) {
        let detail = ""
        try {
          const body = await response.json()
          detail = body && body.error ? String(body.error) : ""
        } catch {
          detail = ""
        }
        throw new Error(detail || "截图失败（HTTP " + response.status + "）")
      }
      const blob = await response.blob()
      const header = response.headers.get("x-shot-path") || ""
      let shotPath = ""
      try {
        shotPath = header ? decodeURIComponent(header) : ""
      } catch {
        shotPath = ""
      }
      return { blob, path: shotPath }
    }

    function findComposerFileInput() {
      if (typeof document === "undefined") return null
      const card = document.querySelector("[data-composer-card]")
      const scope = card || document
      const local = scope.querySelector('input[type="file"]')
      if (local) return local
      return document.querySelector('input[type="file"]')
    }

    /** 模拟一次「选文件」：把 File 塞进隐藏 input 并触发 change，宿主会自己走附件流程。 */
    function seedComposer(input, file) {
      const transfer = new DataTransfer()
      transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event("change", { bubbles: true }))
    }

    /**
     * 把视口里的选区换算成图片像素矩形。
     * @param imageRect - 图片在视口里的显示矩形（getBoundingClientRect）
     * @param selection - 选区（viewport CSS px）
     * @param naturalWidth - 图片原始宽度
     * @param naturalHeight - 图片原始高度
     * @returns {px,py,pw,ph} 或 null（选区太小 / 完全在图外）
     */
    function computeCrop(imageRect, selection, naturalWidth, naturalHeight) {
      if (!imageRect || !selection) return null
      if (!(imageRect.width > 0) || !(imageRect.height > 0)) return null
      if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null
      const right = imageRect.left + imageRect.width
      const bottom = imageRect.top + imageRect.height
      const x1 = Math.max(imageRect.left, Math.min(selection.left, right))
      const y1 = Math.max(imageRect.top, Math.min(selection.top, bottom))
      const x2 = Math.max(imageRect.left, Math.min(selection.left + selection.width, right))
      const y2 = Math.max(imageRect.top, Math.min(selection.top + selection.height, bottom))
      const cw = x2 - x1
      const ch = y2 - y1
      if (cw < MIN_SELECTION || ch < MIN_SELECTION) return null
      const scaleX = naturalWidth / imageRect.width
      const scaleY = naturalHeight / imageRect.height
      return {
        px: Math.round((x1 - imageRect.left) * scaleX),
        py: Math.round((y1 - imageRect.top) * scaleY),
        pw: Math.max(1, Math.round(cw * scaleX)),
        ph: Math.max(1, Math.round(ch * scaleY)),
      }
    }

    /**
     * 冻结画面 + 框选。
     * @param blob - 整屏 PNG
     * @param handlers.onPick - 拿到裁好的 File 与像素尺寸
     * @param handlers.onCancel - 取消（没有选中、Esc、选区过小）
     */
    function openPicker(blob, handlers) {
      const url = URL.createObjectURL(blob)
      const overlay = document.createElement("div")
      overlay.className = "dsh-shot-picker"

      const img = document.createElement("img")
      img.className = "dsh-shot-picker-img"
      img.src = url
      img.alt = ""
      overlay.appendChild(img)

      const tip = document.createElement("div")
      tip.className = "dsh-shot-picker-tip"
      tip.textContent = "拖拽框选 · Enter 整屏 · Esc 取消"
      overlay.appendChild(tip)

      const box = document.createElement("div")
      box.className = "dsh-shot-picker-box"

      const sizeHint = document.createElement("div")
      sizeHint.className = "dsh-shot-picker-size"

      document.body.appendChild(overlay)
      document.body.appendChild(box)
      document.body.appendChild(sizeHint)

      let start = null
      let last = null
      let closed = false
      let ready = false

      img.addEventListener("load", () => {
        ready = true
        tip.textContent = "拖拽框选 · Enter 整屏 · Esc 取消（" + img.naturalWidth + "×" + img.naturalHeight + "）"
      })
      img.addEventListener("error", () => finish(null))

      function cleanup() {
        if (closed) return
        closed = true
        window.removeEventListener("keydown", onKey, true)
        window.removeEventListener("mousemove", onMove, true)
        window.removeEventListener("mouseup", onUp, true)
        overlay.remove()
        box.remove()
        sizeHint.remove()
        URL.revokeObjectURL(url)
      }

      function closeWith(result) {
        cleanup()
        if (result) handlers.onPick(result)
        else handlers.onCancel()
      }

      /** 整屏（不裁）。 */
      function useFull() {
        if (!ready) return
        closeWith({ file: new File([blob], shotName(), { type: "image/png" }), width: img.naturalWidth, height: img.naturalHeight })
      }

      function onKey(event) {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          finish(null)
        } else if (event.key === "Enter") {
          event.preventDefault()
          event.stopPropagation()
          useFull()
        }
      }

      function drawBox(x1, y1, x2, y2) {
        const left = Math.min(x1, x2)
        const top = Math.min(y1, y2)
        const width = Math.abs(x2 - x1)
        const height = Math.abs(y2 - y1)
        box.style.display = "block"
        box.style.left = left + "px"
        box.style.top = top + "px"
        box.style.width = width + "px"
        box.style.height = height + "px"
        const rect = img.getBoundingClientRect()
        if (rect.width > 0) {
          const scale = img.naturalWidth / rect.width
          sizeHint.style.display = "block"
          sizeHint.textContent = Math.round(width * scale) + " × " + Math.round(height * scale)
          sizeHint.style.left = left + "px"
          sizeHint.style.top = Math.max(2, top - 22) + "px"
        }
        return { left, top, width, height }
      }

      function onMove(event) {
        if (!start) return
        last = { x: event.clientX, y: event.clientY }
        drawBox(start.x, start.y, last.x, last.y)
      }

      function finish(rect) {
        if (closed) return
        if (!rect) {
          closeWith(null)
          return
        }
        const imageRect = img.getBoundingClientRect()
        if (imageRect.width <= 0 || imageRect.height <= 0 || !img.naturalWidth) {
          closeWith(null)
          return
        }
        const crop = computeCrop(imageRect, rect, img.naturalWidth, img.naturalHeight)
        if (!crop) {
          closeWith(null)
          return
        }
        const pw = crop.pw
        const ph = crop.ph

        const canvas = document.createElement("canvas")
        canvas.width = pw
        canvas.height = ph
        const context = canvas.getContext("2d")
        if (!context) {
          closeWith(null)
          return
        }
        context.drawImage(img, crop.px, crop.py, pw, ph, 0, 0, pw, ph)
        canvas.toBlob(
          (out) => {
            if (!out) {
              cleanup()
              handlers.onCancel()
              return
            }
            closeWith({ file: new File([out], shotName(), { type: "image/png" }), width: pw, height: ph })
          },
          "image/png",
        )
      }

      function onUp(event) {
        if (!start) return
        const end = { x: event.clientX, y: event.clientY }
        const rect = drawBox(start.x, start.y, end.x, end.y)
        start = null
        box.style.display = "none"
        sizeHint.style.display = "none"
        finish(rect)
      }

      overlay.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        start = { x: event.clientX, y: event.clientY }
        last = start
        drawBox(start.x, start.y, start.x, start.y)
      })
      overlay.addEventListener("dblclick", (event) => {
        event.preventDefault()
        useFull()
      })
      overlay.addEventListener("contextmenu", (event) => {
        event.preventDefault()
        finish(null)
      })
      window.addEventListener("mousemove", onMove, true)
      window.addEventListener("mouseup", onUp, true)
      window.addEventListener("keydown", onKey, true)
    }

    function ShotButton() {
      const [phase, setPhase] = React.useState("idle")
      const [note, setNote] = React.useState("")
      const alive = React.useRef ? React.useRef(true) : null

      React.useEffect(() => {
        if (!alive) return undefined
        alive.current = true
        return function () {
          alive.current = false
        }
      }, [])

      const settle = (next, text) => {
        if (alive && alive.current === false) return
        setPhase(next)
        setNote(text || "")
        setTimeout(() => {
          if (alive && alive.current === false) return
          setPhase("idle")
          setNote("")
        }, 2600)
      }

      const cancel = () => {
        if (alive && alive.current === false) return
        setPhase("idle")
        setNote("")
      }

      const run = async (delayMs) => {
        if (phase === "busy" || phase === "picking") return
        setPhase("busy")
        setNote("")
        try {
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
          const shot = await captureOnce()
          if (alive && alive.current === false) return
          setPhase("picking")
          openPicker(shot.blob, {
            onPick: (result) => {
              const input = findComposerFileInput()
              if (!input || input.disabled) {
                settle("err", "没找到输入框的附件入口")
                return
              }
              try {
                seedComposer(input, result.file)
              } catch (error) {
                settle("err", String((error && error.message) || error))
                return
              }
              settle("ok", result.width + "×" + result.height + (shot.path ? " · " + shot.path : ""))
            },
            onCancel: cancel,
          })
        } catch (error) {
          const message = String((error && error.message) || error)
          settle("err", message)
        }
      }

      const label =
        phase === "busy"
          ? "截图中…"
          : phase === "picking"
            ? "框选中…"
            : phase === "ok"
              ? "已插入"
              : phase === "err"
                ? "失败"
                : "截图"
      const title =
        phase === "err" || phase === "ok"
          ? note
          : "截图后拖拽框选（Shift 点击 = 3 秒后截，方便先切窗口；框选时 Enter = 整屏）"

      return h(
        "button",
        {
          type: "button",
          className: "dsh-shot-btn",
          "data-tone": phase === "ok" ? "ok" : phase === "err" ? "err" : "idle",
          "aria-label": "截图",
          disabled: phase === "busy",
          title,
          onMouseDown: (event) => event.preventDefault(),
          onClick: (event) => {
            run(event.shiftKey ? DELAY_MS : 0)
          },
        },
        CameraIcon(),
        h("span", null, label),
      )
    }

    const inject = ["slots"]

    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject("conversation.input.left", function () {
        return ctx.slots.register(
          { name: "conversation.input.left", id: "screenshot", order: 100 },
          ShotButton,
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    // 内部：给契约测试算裁剪矩形用（宿主不读这个）
    exports.__computeCrop = computeCrop
    return module.exports
  },
})
