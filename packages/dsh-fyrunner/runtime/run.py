# -*- coding: utf-8 -*-
"""
FyRunner 被 DSH 插件托管时的启动壳。

为什么需要它：插件用 Node 的 spawn 起 python，沙箱下不允许继承文件句柄
（stdio 传 fd 会 EPERM），所以日志不能在 Node 侧接管道。
这里在 Python 内部把 stdout/stderr 重定向到 .python.log，Node 侧只需 stdio:'ignore'。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, ".python.log")


def _open_log():
    try:
        f = open(LOG, "a", encoding="utf-8", errors="replace", buffering=1)
        sys.stdout = f
        sys.stderr = f
    except Exception:
        pass


def main():
    _open_log()
    sys.path.insert(0, HERE)
    target = os.path.join(HERE, "server.py")
    code = compile(open(target, "r", encoding="utf-8").read(), target, "exec")
    globals_ = {"__name__": "__main__", "__file__": target, "__builtins__": __builtins__}
    exec(code, globals_)


if __name__ == "__main__":
    main()
