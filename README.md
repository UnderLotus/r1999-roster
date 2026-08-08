# r1999-roster

A quick tool for generating a shareable image of your owned character Box
for ***Reverse: 1999***.

**[繁體中文](README_tw.md)**

---

Tap a character to mark it as owned (0 Portray), tap again to increase Portray
(1 → 2 → … → 5). Use the − button on the top-left to decrease Portray;
decreasing from 0 un-owns the character. Click the clothing icon on the
top-right to switch skins (Default, Insight, Costumes).

Search works across all supported languages. If a character's name is missing
in the current language, the English name is shown as fallback.
The ID field accepts any free-form text, shown at the top-center of the
exported image. Next to the rarity filter is the default-portrait toggle,
switching the default skin between Initial and Insight.

Different servers are on different progressions, so the list defaults to the
global progress. The Future Sight button, at the top of the page, is for
users who want the latest CN-first characters.

---

## Dev

```bash
npm install
npm run dev       # Start dev server
npm run build     # Production build
```

React + TypeScript + Vite + Zustand. See
[docs/scripts.md](docs/scripts.md) for data sync scripts.

---

## Credits

Character data and images sourced from:

- [CN Client Assets (myssal/Reverse-1999-CN-Asset)](https://github.com/myssal/Reverse-1999-CN-Asset)
- [灰機 Wiki (res1999.huijiwiki.com)](https://res1999.huijiwiki.com)
- [Kornblume (windbow27/kornblume)](https://github.com/windbow27/kornblume)
- [wikiru (reverse1999.wikiru.jp)](https://reverse1999.wikiru.jp)
- [Reverse: 1999 Fandom Wiki](https://reverse1999.fandom.com)

All character assets © Bluepoch Co., Ltd.

---

MIT License