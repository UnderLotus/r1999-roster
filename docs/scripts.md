# 腳本說明

本專案提供三個維護腳本，用於增量更新角色資料與圖片。所有資料儲存在 repository 內，網站運行時不進行任何外部請求。

---

## 腳本總覽

| 腳本 | 執行方式 | 用途 |
|---|---|---|
| `scripts/sync-characters.ts` | `npm run sync` | 從灰機 Wiki 增量同步新角色資料與圖片 |
| `scripts/build-names.ts` | `npm run build:names` | 從 Kornblume + wikiru + Fandom 抓取五語系角色名稱 |
| `scripts/download-images.py` | （由 sync-characters.ts 呼叫） | 使用 curl_cffi 下載角色圖片 |
| `scripts/test-store.ts` | `npm run test:store` | 測試 Zustand store 邏輯與持久化遷移 |

---

## `npm run sync` — 增量同步角色

### 運作方式

1. 讀取現有的 `src/data/characters.json`
2. 透過 Jina Reader 抓取灰機 Wiki [角色列表頁](https://res1999.huijiwiki.com/wiki/角色列表)，解析全部角色（ID、名稱、頭像縮圖 URL）
3. 與既有角色比對：**只處理 JSON 中不存在、或圖片資料夾缺失的角色**
4. 分批查詢 `api.php` 取得立繪原圖 URL（每批最多 50 名，避免 Jina URL 長度限制）
5. 呼叫 `download-images.py` 下載圖片
6. 將新角色 append 至 `characters.json`（保留既有角色的所有欄位，包含手動調整的內容與多語系名稱）

### 增量更新行為

- **全新角色** → 自動 append，自動分配 `releaseOrder`
- **既有角色、圖片缺失** → 補下載圖片，保留既有 `names`、`avatarPosition`、`rarity` 等所有欄位
- **既有角色、圖片完整** → 跳過，不做任何變更
- 永遠不會刪除既有角色

### 輸出範例

```
讀取現有角色: 132 名
抓取角色列表頁 (Jina Reader)...
來源角色: 135 名
新增: 3 名，跳過既有: 132 名
查詢立繪 URL（每批 50）...
取得立繪 URL: 3 個
下載圖片 (3 名角色)...
已寫入 3 名新角色、補齊 0 名既有角色圖片
Existing characters: 132
Found from source: 135
New characters added: 3
Skipped existing: 132
Failed images: 0
```

### 前置需求

```bash
# 安裝 curl_cffi（圖片下載需要模擬 Chrome TLS 指紋）
python3 -m venv .venv && .venv/bin/pip install curl_cffi
```

腳本會自動使用 `python3`（可透過 `PYTHON_BIN` 環境變數指定路徑）。

### 安全機制

- 來源角色數明顯少於既有角色數時（< 80%），輸出 warning 但不中斷
- 缺少立繪 URL 的角色會記錄在 `failedCharacters` 摘要
- 圖片下載失敗的角色會記錄原因，不中斷其他角色的處理

---

## `npm run build:names` — 多語系名稱同步

### 運作方式

1. 從 Kornblume（windbow27/kornblume）下載五語系角色名（zh-CN / zh-TW / en-US / ja-JP / ko-KR）
2. 透過 wikiru（日本攻略 wiki）補足 Kornblume 缺少的最新角色日文名
3. 透過 Fandom API 補足韓國語名稱（從 `name_kor` 欄位解析）
4. 依 `releaseOrder` 順序對應角色，產生每個角色的 `names` 欄位
5. 覆寫回 `src/data/characters.json`

### 對應驗證

- Kornblume 角色數必須與本專案角色數一致（數量不符 → 拋錯）
- 每個位置的英文名 slug 必須存在於 Kornblume 的 en-US.json（不一致 → 拋錯）
- 既有角色的 `names["en-US"]` 與 Kornblume 英文名不一致時輸出 warning
- wikiru 無法對應的日文 icon 角色會收集至 unmatched 並輸出 warning
- Fandom 請求失敗數 > 10 → 拋錯（代表來源異常）

### 硬編碼例外

`scripts/data/jp-name-overrides.json` 記錄 Kornblume 尚未收錄的少數新角（日文名 → 英文名對照）。新增角色時若此處需要擴充，腳本會在 wikiru unmatched warning 中提示。

---

## `scripts/test-store.ts` — Store 單元測試

測試 Zustand store 的核心邏輯：

- 角色互動（持有 / 升塑 / 降塑 / 取消持有 / 重設）
- 塑造上限（5 塑不循環）
- 搜尋與篩選
- localStorage 持久化資料遷移（異常值 clamp、型別不正確的清理、舊版格式相容）

執行：`npm run test:store`
