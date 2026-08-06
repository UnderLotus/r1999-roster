# r1999-roster

A character collection tracker for ***Reverse: 1999***. Keep tabs on who you own,
track Portray levels, search across languages, and export your roster as an image.

**[繁體中文](README_tw.md)**

---

Click a character to mark it as owned — it goes from grayscale to full color.
Click again to increase its Portray level, from 0 all the way up to 5. Each card
has quick − and × buttons to decrease Portray or remove the character outright.

The search bar works across all five supported languages (CN / TW / EN / JP / KR),
so you can type a name in whichever language you're most comfortable with. The
language switcher in the top-left changes both the UI text and how character names
are displayed.

Hit **Export JPG** when you want a clean snapshot of your current roster — no UI
elements, just the collection.

All of your data stays in your browser's local storage. No accounts or servers
involved.

---

## Dev

```bash
npm install
npm run dev       # Start dev server
npm run build     # Production build
```

React + TypeScript + Vite + Zustand. For data sync scripts, see
[docs/scripts.md](docs/scripts.md).

---

Fan-made project. All character assets belong to Bluepoch Co., Ltd.
