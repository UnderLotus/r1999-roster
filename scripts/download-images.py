#!/usr/bin/env python3
"""下載角色圖片（使用 curl_cffi 模擬 Chrome TLS 指紋，繞過 Cloudflare 403）。

由 sync-characters.ts 呼叫，透過 stdin 接收 JSON：
  [
    {
      "id": "314901",
      "full": "https://.../Portrait-314901.webp",
      "avatar": "https://.../Headicon_large-314901.png",
      "insight": "https://.../Headicon_large-314902.webp",
      "outputDir": "/abs/path/public/assets/characters/314901"
    },
    ...
  ]

輸出（stdout）：
  { "succeeded": [ids], "failed": { id: "原因" } }

輸出檔案：
  {outputDir}/full.webp    立繪（初始，來源原檔 webp）
  {outputDir}/avatar.png   頭像長圖（來源原始 PNG，228×524）
  {outputDir}/insight.webp 洞悉版頭像（來源原始 webp，可選）

需要 curl_cffi：
  python3 -m venv .venv && .venv/bin/pip install curl_cffi
"""

import json
import os
import sys

try:
    from curl_cffi import requests as creq
except ImportError:
    print(json.dumps({"error": "缺少 curl_cffi：請 pip install curl_cffi"}), file=sys.stderr)
    sys.exit(1)


def download(url: str, dest: str, expected_magic: bytes | None = None) -> None:
    resp = creq.get(url, impersonate="chrome", timeout=30)
    resp.raise_for_status()
    if expected_magic is not None and not resp.content.startswith(expected_magic):
        raise ValueError(f"回應內容不是預期格式（{dest}）")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(resp.content)


PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
WEBP_MAGIC = b"RIFF"


def main() -> None:
    items = json.load(sys.stdin)

    succeeded: list[str] = []
    failed: dict[str, str] = {}

    for item in items:
        cid = item["id"]
        out_dir = item["outputDir"]
        full_dest = os.path.join(out_dir, "full.webp")
        avatar_dest = os.path.join(out_dir, "avatar.png")
        insight_dest = os.path.join(out_dir, "insight.webp")
        full_tmp = full_dest + ".tmp"
        avatar_tmp = avatar_dest + ".tmp"
        insight_tmp = insight_dest + ".tmp"
        has_full = item.get("full", "").startswith("http")
        has_avatar = item.get("avatar", "").startswith("http")
        has_insight = item.get("insight", "").startswith("http")
        try:
            if has_full:
                download(item["full"], full_tmp, WEBP_MAGIC)
            if has_avatar:
                download(item["avatar"], avatar_tmp, PNG_MAGIC)
            if has_insight:
                download(item["insight"], insight_tmp, WEBP_MAGIC)
            if has_full:
                os.replace(full_tmp, full_dest)
            if has_avatar:
                os.replace(avatar_tmp, avatar_dest)
            if has_insight:
                os.replace(insight_tmp, insight_dest)
            succeeded.append(cid)
        except Exception as exc:
            failed[cid] = f"{type(exc).__name__}: {exc}"
            for f in (full_tmp, avatar_tmp, insight_tmp):
                if os.path.exists(f):
                    os.remove(f)

    print(json.dumps({"succeeded": succeeded, "failed": failed}, ensure_ascii=False))


if __name__ == "__main__":
    main()
