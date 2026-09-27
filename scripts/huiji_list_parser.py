"""Pure Huiji character-list card parsing (stdlib only)."""

from html.parser import HTMLParser
import re

_CARD_CLASSES = {"character-list-block", "tabber-item"}
_HEADICON_PATTERN = re.compile(r'Headicon[^"]*large-(\d+)\.png')


class _Card:
    def __init__(self, raw_rarity: str | None) -> None:
        self.raw_rarity = raw_rarity
        self.href: str | None = None
        self.name: str | None = None
        self.variant_id: int | None = None


class _CardParser(HTMLParser):
    """Collect each card independently so malformed markup cannot cross cards."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cards: list[_Card] = []
        self._active: _Card | None = None
        self._active_depth: int | None = None
        self._div_depth = 0

    def _finalize_active(self) -> None:
        if self._active is not None:
            self.cards.append(self._active)
        self._active = None
        self._active_depth = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "div":
            self._div_depth += 1
            if _CARD_CLASSES.issubset(
                set((attributes.get("class") or "").split())
            ):
                # A new recognized container also closes a malformed prior card
                # that did not provide its matching </div>.
                self._finalize_active()
                self._active = _Card(attributes.get("data-rare"))
                self._active_depth = self._div_depth
            return

        if self._active is None:
            return
        if tag == "a":
            href = attributes.get("href")
            name = attributes.get("title")
            if href is not None and name is not None:
                self._active.href = href
                self._active.name = name
        elif tag == "img" and self._active.variant_id is None:
            alt = attributes.get("alt") or ""
            match = _HEADICON_PATTERN.search(alt)
            if match is not None:
                self._active.variant_id = int(match.group(1))

    def handle_endtag(self, tag: str) -> None:
        if tag != "div":
            return
        if self._active is not None and self._active_depth == self._div_depth:
            self._finalize_active()
        if self._div_depth > 0:
            self._div_depth -= 1

    def finish(self) -> None:
        # EOF fallback also clears the active state, so a caller cannot emit
        # the same card again after a matching close or next-card boundary.
        self._finalize_active()


def _normalize_rarity(raw_rarity: str, variant_id: int) -> int:
    try:
        rarity = int(raw_rarity.strip()) + 1
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"invalid Huiji rarity {raw_rarity!r} for variant {variant_id}"
        ) from exc
    if not isinstance(rarity, int) or rarity < 2 or rarity > 6:
        raise ValueError(f"invalid Huiji rarity {raw_rarity!r} for variant {variant_id}")
    return rarity


def parse_cards(html: str) -> list[dict]:
    """Return display-ordered cards with roster rarity (Huiji data-rare + 1)."""
    parser = _CardParser()
    parser.feed(html)
    parser.close()
    parser.finish()

    entries: dict[int, tuple[int, dict]] = {}
    for seq, raw_card in enumerate(parser.cards):
        if raw_card.raw_rarity is None or raw_card.variant_id is None:
            continue
        if raw_card.href is None or raw_card.name is None:
            continue
        card = {
            "id": raw_card.variant_id,
            "name": raw_card.name,
            "href": "https://res1999.huijiwiki.com" + raw_card.href,
            "rarity": _normalize_rarity(raw_card.raw_rarity, raw_card.variant_id),
        }
        # Keep the last occurrence; duplicate cards in page previews can precede
        # the authoritative card in the display list.
        entries[raw_card.variant_id] = (seq, card)
    return [card for _, card in sorted(entries.values(), key=lambda item: item[0])]
