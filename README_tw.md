# r1999-roster

快速分享《重返未來：1999》持有角色 Box 的圖片生產工具。

**[English](README.md)**

---

點一下角色即會變成持有狀態（0 塑），再點就會升塑（1 塑 → 2 塑 → ... → 5 塑）；
用角色卡上方的 − 來降塑造、或直接點 × 變回未持有。

支援全語系角色名稱搜尋，若資料庫沒抓到角色名稱會優先顯示英文名稱。

---

## 開發

```bash
npm install
npm run dev       # 啟動開發伺服器
npm run build     # 生產建置
```

React + TypeScript + Vite + Zustand。資料同步腳本說明請見
[docs/scripts.md](docs/scripts.md)。

---

## 資料來源

角色資料與圖片來源：

- [灰機 Wiki (res1999.huijiwiki.com)](https://res1999.huijiwiki.com)
- [Kornblume (windbow27/kornblume)](https://github.com/windbow27/kornblume)
- [wikiru (reverse1999.wikiru.jp)](https://reverse1999.wikiru.jp)
- [Reverse: 1999 Fandom Wiki](https://reverse1999.fandom.com)

所有角色素材版權歸屬 Bluepoch Co., Ltd.（深藍互動）。

---

MIT License
