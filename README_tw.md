# r1999-roster

將《重返未來：1999》持有角色 Box 分享為圖片或網址的工具。

**[English](README.md)**

---

點一下角色即會變成持有狀態（0 塑），再點就會升塑（1 塑 → 2 塑 → ... → 5 塑）；
角色卡左上方的 − ，用來降塑造，降到 0 塑後再按一次即取消持有。
角色卡右上方的衣服 Icon ，用來切換角色 Skin（初始、洞悉、時裝）。

搜尋欄位支援全語系角色名稱搜尋，若該語系資料庫未有角色名稱、會優先顯示英文名稱。
輸入ID可以自由輸入任何文字，會顯示在輸出圖片的中間最上方。
星數過濾器右邊為切換預設立繪的按鈕，點擊後可以切換預設為初始或洞悉立繪。
「分享網址」可直接複製目前 Box 狀態，不需上傳資料或建立帳號。

最後，由於各國伺服器不同進度問題，預設顯示海外伺服器進度內容。
中間最上方為未來視按鈕，提供給需要最新進度資料的使用者。

---

## 開發

```bash
npm install
npm run dev       # 啟動開發伺服器
npm run build     # 生產建置
```

React + TypeScript + Vite + Zustand。資料同步腳本說明請見
[docs/maintenance.md](docs/maintenance.md)。

---

## 資料來源

角色資料、名稱與圖片來源：

- [CN 客戶端素材 (myssal/Reverse-1999-CN-Asset)](https://github.com/myssal/Reverse-1999-CN-Asset) — 角色 ID、Skin 變體與來源圖片
- [Global 客戶端解包資料 (St-Pavlov-Foundation/re1999-data-global)](https://github.com/St-Pavlov-Foundation/re1999-data-global) — 官方英文顯示名稱
- [灰機 Wiki (res1999.huijiwiki.com)](https://res1999.huijiwiki.com)
- [Kornblume (windbow27/kornblume)](https://github.com/windbow27/kornblume)
- [wikiru (reverse1999.wikiru.jp)](https://reverse1999.wikiru.jp)
- [Reverse: 1999 Fandom Wiki](https://reverse1999.fandom.com)

所有角色素材版權歸屬 Bluepoch Co., Ltd.（深藍互動）。

---

MIT License
