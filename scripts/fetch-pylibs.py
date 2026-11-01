"""绕过 pip 的 wheel 取件器：从清华镜像 PyPI JSON 找 wheel，直接下载解压到 target。

用法: python getwheel.py <targetDir> <pkg> [pkg...]
"""
import json
import os
import sys
import zipfile
import urllib.request

MIRROR = "https://pypi.tuna.tsinghua.edu.cn"


def pick_wheel(urls, pyver="cp312", plat="win_amd64"):
    """优先 cp312-win_amd64，其次 py3-none-any。"""
    best = None
    for u in urls:
        name = u.rsplit("/", 1)[-1].lower()
        if not name.endswith(".whl"):
            continue
        if pyver in name and plat in name:
            return u
        if "py3-none-any" in name and best is None:
            best = u
    return best


def install(target, pkg):
    url = f"{MIRROR}/pypi/{pkg}/json"
    with urllib.request.urlopen(url, timeout=30) as r:
        meta = json.load(r)
    files = meta["urls"]
    cand = [f["url"] for f in files]
    whl = pick_wheel(cand)
    if whl is None:
        cands = [f["url"] for f in meta["releases"][meta["info"]["version"]]]
        whl = pick_wheel(cands)
    if whl is None:
        print(f"SKIP {pkg}: 无 win_amd64/py3 wheel")
        return False
    local = os.path.join(target, "_whl", whl.rsplit("/", 1)[-1])
    os.makedirs(os.path.dirname(local), exist_ok=True)
    if not os.path.exists(local):
        urllib.request.urlretrieve(whl, local)
    with zipfile.ZipFile(local) as z:
        z.extractall(target)
    print(f"OK {pkg} <- {whl.rsplit('/', 1)[-1]}")
    return True


if __name__ == "__main__":
    target = sys.argv[1]
    os.makedirs(target, exist_ok=True)
    ok = 0
    for p in sys.argv[2:]:
        try:
            ok += 1 if install(target, p) else 0
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {p}: {e}")
    print(f"done {ok}/{len(sys.argv) - 2}")
