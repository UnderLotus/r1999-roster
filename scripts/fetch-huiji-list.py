#!/usr/bin/env python3
"""抓取灰機 Wiki「角色列表」頁的完整角色卡（順序＝顯示順序）。

由 sync-wiki-list.ts 呼叫；透過 stdout 輸出 JSON：
  [
    {
      "id": 314901,                  // variant ID（headicon 檔名，例 314901）
      "name": "双生舞伶",           // 頁面 title（中文名）
      "href": "https://res1999.huijiwiki.com/wiki/%E5%8F%8C%E7%94%9F%E8%88%9E%E4%BC%B6"  // 官方 wiki 頁網址
    },
    ...
  ]

Cloudflare：res1999.huijiwiki.com 對 api.php 與一般瀏覽器 UA 回 403 challenge，
使用 curl_cffi impersonate=chrome124 模擬 Chrome TLS 指紋繞過。
若 CF 更新挑戰讓 chrome124 失效，往上調 impersonation 版本即可（chrome131 / chrome）。

需要 curl_cffi：
  python3 -m venv .venv && .venv/bin/pip install curl_cffi

失敗時 stderr 輸出原因並 exit 1（不產生 stdout 輸出）。
"""

import json
import re
import sys

try:
    from curl_cffi import requests as creq
except ImportError:
    print("缺少 curl_cffi：請執行 .venv/bin/pip install curl_cffi", file=sys.stderr)
    sys.exit(1)

LIST_URL = "https://res1999.huijiwiki.com/index.php?title=%E8%A7%92%E8%89%B2%E5%88%97%E8%A1%A8"
IMPERSONATIONS = ["chrome124", "chrome131", "chrome"]


def fetch_html() -> str:
    last_err: Exception | None = None
    for imp in IMPERSONATIONS:
        try:
            resp = creq.get(LIST_URL, impersonate=imp, timeout=30)
            if resp.status_code == 200 and "Just a moment" not in resp.text[:300]:
                return resp.text
            last_err = RuntimeError(f"HTTP {resp.status_code}（Cloudflare challenge）")
        except Exception as exc:  # noqa: BLE001
            last_err = exc
    raise RuntimeError(f"所有 impersonation 均失敗：{last_err}")


def parse_cards(html: str) -> list[dict]:
    # 卡片結構：<a href="/wiki/頁面" title="中文名"><img alt="Headicon large-{id}.png" ...>
    pattern = re.compile(
        r'<a href="(/wiki/[^"]+)" title="([^"]*)">\s*<img[^>]*alt="Headicon[^"]*large-(\d+)\.png"',
        re.S,
    )
    cards: list[dict] = []
    # keep-LAST dedupe：若未來頁面上方出現重複/預覽區塊，主列表在後，
    # 保留最後一次出現才不會讓索引被預覽卡蓋掉
    entries: dict[int, tuple[int, dict]] = {}
    for seq, (href, name, id_str) in enumerate(pattern.findall(html)):
        cid = int(id_str)
        entries[cid] = (
            seq,
            {
                "id": cid,
                "name": name,
                "href": "https://res1999.huijiwiki.com" + href,
            },
        )
    cards = [card for _, card in sorted(entries.values(), key=lambda kv: kv[0])]
    return cards


def main() -> None:
    html = fetch_html()
    cards = parse_cards(html)
    if len(cards) < 100:
        print(
            f"解析異常：僅取得 {len(cards)} 張卡（頁面結構可能變動）",
            file=sys.stderr,
        )
        sys.exit(1)
    print(json.dumps(cards, ensure_ascii=False))


if __name__ == "__main__":
    main()