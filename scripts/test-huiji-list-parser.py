import importlib.util
import sys
from pathlib import Path

sys.dont_write_bytecode = True

MODULE = Path(__file__).with_name("huiji_list_parser.py")
spec = importlib.util.spec_from_file_location("huiji_list_parser", MODULE)
parser = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(parser)

# Ms. Radio (live Huiji title: 无线电小姐)
final_card = parser.parse_cards(
    '''
    <div class="character-list-block tabber-item" data-rare="5">
      <div class="nested-content">
        <a href="/wiki/无线电小姐" title="无线电小姐">
          <img alt="Headicon large-302701.png" />
        </a>
      </div>
    </div>
    <footer>
      <a href="/wiki/Footer" title="Footer link">Footer link</a>
    </footer>
    '''
)
assert len(final_card) == 1, final_card
assert final_card[0]["id"] == 302701, final_card
assert final_card[0]["name"] == "无线电小姐", final_card
assert final_card[0]["href"] == "https://res1999.huijiwiki.com/wiki/无线电小姐", final_card

cards = parser.parse_cards(
    '''
    <div class="character-list-block tabber-item" data-rare="4">
      <a href="/wiki/First-old" title="First old">
        <img alt="Headicon large-100101.png" />
      </a>
    </div>
    <div class="character-list-block tabber-item" data-rare="5">
      <a href="/wiki/Malformed" title="Malformed">
        <img alt="Not a headicon" />
      </a>
    </div>
    <div class="character-list-block tabber-item" data-rare="2">
      <a href="/wiki/Second" title="Second">
        <img alt="Headicon large-200201.png" />
      </a>
    </div>
    <div class="character-list-block tabber-item" data-rare="3">
      <a href="/wiki/First-new" title="First new">
        <img alt="Headicon large-100101.png" />
      </a>
    </div>
    '''
)
assert cards == [
    {
        "id": 200201,
        "name": "Second",
        "href": "https://res1999.huijiwiki.com/wiki/Second",
        "rarity": 3,
    },
    {
        "id": 100101,
        "name": "First new",
        "href": "https://res1999.huijiwiki.com/wiki/First-new",
        "rarity": 4,
    },
], cards

try:
    parser.parse_cards(
        '''
        <div class="character-list-block tabber-item" data-rare="6">
          <a href="/wiki/Invalid" title="Invalid">
            <img alt="Headicon large-300301.png" />
          </a>
        </div>
        '''
    )
except ValueError as error:
    assert "300301" in str(error)
else:
    raise AssertionError("out-of-range normalized rarity must fail")

print("ok: Huiji parser is card-boundary safe with last-duplicate ordering and rarity validation")
