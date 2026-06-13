# GM Narrative Header

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that prepends a formatted, in-narrative **status header** to every GM (AI) message — HP/MP, world time, conditions, inventory, abilities, and anything else your system tracks.

The header is populated live from the [`gm-lore-parser`](https://github.com/zandao682/SillyTavern-GMLoreParser) player-entity state stored in `chatMetadata`, so the numbers always reflect the current world.

```
Name: Kaelen   Title: Dawnbreaker   Rank: B
Class: Spellblade   Level: 7   XP: 1840/2400
Date: 14th of Frostmoon, 1042 — Dusk
HP: 78/120 (+1.5/min)   MP: 40/60 (+0.5/min)   Vigor: 90/100 (+2/min)
Hunger: 68%   Thirst: 75%
Status: Bleeding, Inspired   Coin: 14 gold, 8 silver   Inventory: 14 items
---
The tavern door groans open behind you...
```

---

## What's new in v2

v2 follows the **gm-lore-parser v9** (system-agnostic) spec:

- Reads the unified **player-entity** shape — identity (`name` / `class` / `background`), `values` + `schema`, `skill_system`, `needs` meters, and the `adventurer_rank`.
- Resolves the unified **abilities** list (`boon` / `title` / `passive` / `trait` / `evolution`) — including the active title.
- New tokens for **currency**, **reputation**, and **needs-meter percentages**.
- Skill-score tokens are **system-definition aware**: they use the ruleset's `score_formula` (from `[SYSTEM_DEF]`) when no per-chat formula is set.

---

## Features

- **Live status block** prepended to every GM message, rendered in-narrative.
- **System-defined format** — the GM/Architect card emits a `[HEADER_FORMAT_BEGIN]…[HEADER_FORMAT_END]` block once, and the format persists per-chat in `chatMetadata`.
- **Manual fallback format** configurable in the extension settings panel.
- **Rich token language** — identity, fields, maxes, regen rates, needs percentages, world time, conditions, inventory, currency, reputation, abilities, and calculated skill scores.
- **Configurable separator** between the header and the narration.
- Pulls all state from `gm-lore-parser` (optional dependency) — read-only, no extra bookkeeping.

---

## Installation

1. In SillyTavern, open **Extensions → Install Extension**.
2. Paste the repository URL, **or** copy this folder into:
   ```
   SillyTavern/public/scripts/extensions/third-party/gm-narrative-header/
   ```
3. Reload SillyTavern. The extension appears under **Extensions → GM Narrative Header**.

**Requirements**

| | |
|---|---|
| Minimum client version | `1.12.0` |
| Optional dependency | [`gm-lore-parser`](https://github.com/zandao682/SillyTavern-GMLoreParser) (provides the player-entity state the header reads) |
| Loading order | `20` (loads after the lore parser) |

Without `gm-lore-parser` installed the header still renders, but unresolved tokens are left as literal `{token}` text.

---

## Usage

### 1. Define a format (recommended: via the card)

Have your GM or Architect card emit a header-format block **once** in a message. The extension captures it, stores it in chat metadata, strips the block from the visible message, and uses it for all subsequent messages:

```
[HEADER_FORMAT_BEGIN]
Name: {name}   Title: {active_title}   Rank: {rank}
Class: {class}   Level: {level}   XP: {xp}/{xp_next}
Date: {date}
HP: {hp}/{hp_max} ({hp_regen}/min)   MP: {mp}/{mp_max} ({mp_regen}/min)
Hunger: {hunger_pct}%   Thirst: {thirst_pct}%
Status: {conditions}   Coin: {currency}   Inventory: {inventory_count} items
[HEADER_FORMAT_END]
```

Only reference tokens for fields and subsystems your system actually defines — a levelless or classless system simply omits `{level}` / `{class}`.

### 2. Or set a manual format

Open **Extensions → GM Narrative Header** and enter a format string in **Manual format (fallback)**. This is used whenever no `[HEADER_FORMAT]` block has been captured for the current chat.

---

## Token Reference

| Token | Resolves to |
|---|---|
| `{name}` / `{class}` / `{background}` | Player identity (top-level entity fields) |
| `{rank}` | Adventurer / guild rank |
| `{field_key}` | A schema field value, or a needs-meter value (arrays are comma-joined) |
| `{field_key_max}` | The maximum — schema `max_field`, or a needs meter's max |
| `{field_key_regen}` | Schema regen rate **per minute**, signed (e.g. `+1.5`, `-0.5`) — normalized from hour/day rates |
| `{field_key_pct}` | Percentage for a needs meter (or a value/max_field pair) |
| `{time}` / `{date}` | `world_time.display` from the lore parser |
| `{conditions}` | Active conditions, comma-joined, or `None` |
| `{inventory_count}` / `{inventory_max}` | Items carried / capacity (`inventory_max` / `bag_slots`) |
| `{active_title}` | The currently active title |
| `{titles}` / `{boons}` / `{abilities}` | Names by category (`abilities` = all non-title) |
| `{currency}` | All non-zero denominations, e.g. `14 gold, 8 silver` |
| `{currency:denom}` | A single denomination's amount |
| `{reputation:Faction Name}` | `Tier (standing)` for that faction |
| `{skill_score:SkillName}` | Calculated skill score (uses the system definition's formula when not set per-chat) |
| `{xp_next}` | XP needed for next level (`xp_next` / `xp_to_next_level`) |

Any token that can't be resolved is left untouched as `{token}`, making missing fields easy to spot.

---

## Settings

Found under **Extensions → GM Narrative Header**:

| Setting | Default | Description |
|---|---|---|
| **Enable narrative header** | `on` | Master toggle for the extension. |
| **Prepend to every GM message** | `on` | When off, the header is only inserted on messages that carry a new `[HEADER_FORMAT]` block. |
| **Use format from `[HEADER_FORMAT]` block** | `on` | Prefer the captured per-chat format over the manual fallback. |
| **Header / message separator** | `---` | Line drawn between the header and the narration (`---`, `═══`, or blank). |
| **Manual format (fallback)** | *(empty)* | Format string used when no block is captured for the chat. |

---

## How It Works

1. On `MESSAGE_RECEIVED`, the extension inspects each GM message.
2. If the message contains a `[HEADER_FORMAT_BEGIN]…[HEADER_FORMAT_END]` block, that format is saved to `chatMetadata[gm-narrative-header]` and the block is stripped from the visible text.
3. The active format (captured block, or manual fallback) is rendered by replacing every `{token}` against the live `gm-lore-parser` player-entity state in `chatMetadata[gm-lore-parser]`.
4. The rendered header + separator is prepended to `message.mes` and re-rendered into the DOM via SillyTavern's `messageFormatting`.

State is read-only from the header's perspective — it never mutates the lore parser's data, only reads it.

---

## Files

| File | Purpose |
|---|---|
| `index.js` | Extension logic: token resolution, block parsing, message handler, settings UI. |
| `style.css` | Settings-panel styling and the in-chat header block (`.gnh-header-block`). |
| `manifest.json` | Extension metadata, dependencies, and loading order. |

---

## License

Provided as-is for use with SillyTavern. Set your author/license details in `manifest.json`.
