/**
 * GM Narrative Header — SillyTavern Extension  v0.0.4 (beta)
 *
 * Prepends a formatted status header to every GM (AI) message.
 * The header is populated from gm-lore-parser (v9) player-entity state in
 * chatMetadata['gm-lore-parser']. State is read-only here — never mutated.
 *
 * Format is a template string where {token} placeholders are replaced with live
 * values. Systems define their own format via a [HEADER_FORMAT_BEGIN] block
 * (emitted by the GM/Architect card), which persists per-chat in chatMetadata.
 *
 * Reads the v9 shape: identity (name/class_/background), `values` + `schema`,
 * `needs` meters, unified `capabilities` (boon/title/passive/trait/evolution/
 * skill — static or progressing), `reputation`, `currency`, `adventurer_rank`,
 * and the `system_def` ruleset (for exclusive-category / progression lookup).
 *
 * Example header template:
 *   Name: {name}   Title: {active_title}   Rank: {rank}
 *   Class: {class}   Level: {level}   XP: {xp}/{xp_next}
 *   Date: {date}
 *   HP: {hp}/{hp_max} ({hp_regen}/min)   MP: {mp}/{mp_max} ({mp_regen}/min)
 *   Hunger: {hunger_pct}%   Thirst: {thirst_pct}%
 *   Status: {conditions}   Coin: {currency}   Inventory: {inventory_count} items
 *
 * Tokens:
 *   {name} {class} {background} {rank}  — player identity / adventurer rank
 *   {field_key}                         — a schema field value (or a needs meter value)
 *   {field_key_max}                     — max (schema max_field, or needs meter max)
 *   {field_key_regen}                   — schema regen rate per minute, signed
 *   {field_key_pct}                     — percentage for a needs meter (or max_field pair)
 *   {time} / {date}                     — world_time.display
 *   {conditions}                        — comma-joined conditions or "None"
 *   {inventory_count} / {inventory_max} — inventory size / capacity
 *   {active_title} {titles} {boons} {abilities} — capabilities by category
 *   {currency} / {currency:denom}       — all coin, or one denomination
 *   {reputation:Faction Name}           — "Tier (standing)"
 *   {skill_score:SkillName}             — progressing capability's score
 *   {xp_next}                           — XP to next level (if the system tracks it)
 *
 * The header is prepended to the AI message text so it appears in-narrative.
 * It can be toggled per-conversation or globally.
 *
 * Missing/unknown tokens resolve to nothing (never a literal {token}); a line
 * whose tokens ALL resolve empty is dropped, and leftover artifacts (orphan "/",
 * empty "()", stray separators) are tidied. Put one stat per line for the
 * cleanest auto-hiding of absent data.
 */

const MODULE_NAME = 'gm-narrative-header';
const VERSION     = '0.0.4';
const LORE_PARSER = 'gm-lore-parser'; // sibling extension's metadata key

const HEADER_BLOCK = {
    begin: '[HEADER_FORMAT_BEGIN]',
    end:   '[HEADER_FORMAT_END]',
};

// ─── Default settings ────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = Object.freeze({
    enabled:        true,
    useFormatBlock: true,   // use format from HEADER_FORMAT block if present
    manualFormat:   '',     // fallback manual format string
    separator:      '---',  // line between header and narration ('---', '═══', '', etc.)
    showOnEveryMsg: true,   // prepend to every GM message vs only when state changes
});

// ─── Default per-chat header state (stored in chatMetadata) ──────────────────

const CHAT_KEY = MODULE_NAME;

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME])
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    for (const [k,v] of Object.entries(DEFAULT_SETTINGS))
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], k))
            extensionSettings[MODULE_NAME][k] = v;
    return extensionSettings[MODULE_NAME];
}

function getChatState() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[CHAT_KEY]) chatMetadata[CHAT_KEY] = { format: '' };
    return chatMetadata[CHAT_KEY];
}

async function saveChatState() {
    await SillyTavern.getContext().saveMetadata();
}

// ─── Character state access ───────────────────────────────────────────────────

function getCharState() {
    const { chatMetadata } = SillyTavern.getContext();
    return chatMetadata[LORE_PARSER] || null;
}

// ─── Regen rate computation ───────────────────────────────────────────────────

function regenPerMinute(desc) {
    if (!desc?.regen?.rate) return 0;
    const r = desc.regen.rate;
    if (desc.regen.time_unit === 'hour') return r / 60;
    if (desc.regen.time_unit === 'day')  return r / 1440;
    return r;
}

function formatRegen(rpmFloat) {
    if (!rpmFloat) return '0';
    const abs  = Math.abs(rpmFloat);
    const str  = abs < 0.1 ? abs.toFixed(2) : abs < 1 ? abs.toFixed(1) : abs % 1 === 0 ? abs.toString() : abs.toFixed(1);
    return rpmFloat < 0 ? `-${str}` : `+${str}`;
}

// ─── Token resolution ─────────────────────────────────────────────────────────

/** Does this capability advance (skill-like) under the active System Definition? */
function capIsProgressing(cap, def) {
    const id = cap.progression_id || def?.capabilities?.category_progression?.[cap.category] || 'none';
    const p  = (def?.progressions || []).find(x => x.id === id);
    return !!(p && p.type && p.type !== 'none');
}

// Genuinely-missing/unknown data resolves to this empty sentinel; renderHeader
// then strips it (and drops any line whose tokens all came back empty).
function resolveToken(token, charState) {
    if (!charState) return '';
    const values     = charState.values || {};
    const schema     = charState.schema?.fields || {};
    const def        = charState.system_def || null;
    const needs      = charState.needs || {};
    const caps       = (charState.capabilities && typeof charState.capabilities === 'object')
        ? Object.values(charState.capabilities).filter(c => (c.entity_slug || 'player') === 'player') : [];
    const exCat      = def?.capabilities?.exclusive_category || 'title';
    const emptyLabel = def?.presentation?.empty_label || 'None';

    // ── Identity (lives at the top level of the player entity, not in values) ──
    if (token === 'name')       return charState.name       || '';
    if (token === 'class')      return charState.class_      || '';
    if (token === 'background') return charState.background  || '';
    if (token === 'rank')       return charState.adventurer_rank?.rank || '';

    // Special tokens
    if (token === 'time' || token === 'date')
        return charState.world_time?.display || '';

    if (token === 'conditions')
        return (Array.isArray(values.conditions) && values.conditions.length)
            ? values.conditions.join(', ') : emptyLabel;

    if (token === 'inventory_count')
        return Array.isArray(values.inventory) ? values.inventory.length : 0;

    if (token === 'inventory_max')
        return def?.inventory?.capacity ?? values.inventory_max ?? values.bag_slots ?? '';

    // ── Capabilities (unified: boon | title | passive | trait | evolution | skill) ──
    if (token === 'active_title') {
        const t = caps.find(c => c.category === exCat && c.active);
        return t ? t.name : '';
    }
    if (token === 'titles')
        return caps.filter(c => c.category === exCat).map(c => c.name).join(', ') || emptyLabel;
    if (token === 'boons')
        return caps.filter(c => c.category === 'boon').map(c => c.name).join(', ') || emptyLabel;
    if (token === 'abilities')
        return caps.filter(c => c.category !== exCat && !capIsProgressing(c, def)).map(c => c.name).join(', ') || emptyLabel;

    // ── Currency: {currency} (all denominations) or {currency:gold} ──
    if (token === 'currency') {
        const c = charState.currency || {};
        const parts = Object.entries(c).filter(([, v]) => v > 0).map(([d, v]) => `${v} ${d}`);
        return parts.length ? parts.join(', ') : '';
    }
    if (token.startsWith('currency:')) {
        const denom = token.slice(9).trim().toLowerCase();
        return charState.currency?.[denom] ?? 0;
    }

    // ── Reputation: {reputation:Faction Name} → "Tier (standing)" ──
    if (token.startsWith('reputation:')) {
        const wanted = token.slice(11).trim().toLowerCase();
        const rep = Object.values(charState.reputation || {})
            .find(r => (r.name || '').toLowerCase() === wanted);
        return rep ? `${rep.tier} (${rep.standing})` : '';
    }

    // ── Skill score: {skill_score:Swordsmanship} ──
    // The parser precomputes prog.score per its progression profile, so the
    // header just reads it — no formula evaluation or system-specific math here.
    if (token.startsWith('skill_score:')) {
        const wanted = token.slice(12).trim().toLowerCase();
        const cap = caps.find(c => (c.name || '').toLowerCase() === wanted);
        return (cap && cap.prog && cap.prog.score !== undefined) ? cap.prog.score : '';
    }

    // ── _regen suffix (schema regen rate per minute) ──
    if (token.endsWith('_regen')) {
        const baseKey = token.slice(0, -6);
        const rpm = regenPerMinute(schema[baseKey]);
        return rpm ? formatRegen(rpm) : '';   // hide when the field has no regen
    }

    // ── _pct suffix (needs meter percentage) ──
    if (token.endsWith('_pct')) {
        const baseKey = token.slice(0, -4);
        const meter = needs[baseKey];
        if (meter && meter.max) return Math.round((meter.value / meter.max) * 100);
        if (values[baseKey] !== undefined && schema[baseKey]?.max_field)
            return Math.round((values[baseKey] / (values[schema[baseKey].max_field] || 1)) * 100);
        return '';
    }

    // ── _max suffix (schema max_field, direct value, or needs meter max) ──
    if (token.endsWith('_max')) {
        const baseKey = token.slice(0, -4);
        if (values[token] !== undefined) return values[token];
        const desc = schema[baseKey];
        if (desc?.max_field) return values[desc.max_field] ?? '';
        if (needs[baseKey]) return needs[baseKey].max ?? '';
        return '';
    }

    // xp_next — XP needed for next level (system must define this or GM sets it)
    if (token === 'xp_next') return values.xp_next ?? values.xp_to_next_level ?? '';

    // Direct schema-value lookup
    if (values[token] !== undefined) {
        const v = values[token];
        return Array.isArray(v) ? v.join(', ') : v;
    }

    // Needs meter value (when modeled as a separate meter, not a schema field)
    if (needs[token] !== undefined) return needs[token].value;

    // Not found → empty (hidden), never a literal {token}
    return '';
}

/** Tidy artifacts left behind when a token resolved to empty on a populated line:
 *  orphaned slashes, empty brackets/parens, doubled spaces, dangling separators. */
function cleanupHeaderLine(s) {
    return s
        .replace(/\(\s*\)/g, '')                 // empty ()
        .replace(/\[\s*\]/g, '')                 // empty []
        .replace(/\s*\/\s*(?=\s|$)/g, '')        // trailing/orphan slash
        .replace(/(^|[\s|·])\/\s*/g, '$1')       // leading orphan slash
        .replace(/\s+([,;:|·])/g, '$1')          // space before separators
        .replace(/([,;|·])\s*$/g, '')            // trailing separator
        .replace(/\s{2,}/g, ' ')                 // collapse doubled spaces
        .trimEnd();
}

function renderHeader(format, charState) {
    if (!format) return null;
    const lines = format.split('\n').map(line => {
        let hadToken = false, allEmpty = true;
        const replaced = line.replace(/\{([^}]+)\}/g, (_, token) => {
            hadToken = true;
            const v = resolveToken(token.trim(), charState);
            const s = (v === null || v === undefined) ? '' : String(v);
            if (s !== '') allEmpty = false;
            return s;
        });
        // Drop a line whose tokens ALL resolved empty (e.g. "MP {mp}/{mp_max}").
        if (hadToken && allEmpty) return null;
        return cleanupHeaderLine(replaced);
    }).filter(l => l !== null && l.trim() !== '');
    const result = lines.join('\n').trim();
    return result || null;
}

// ─── Block parsing ────────────────────────────────────────────────────────────

function extractHeaderFormat(text) {
    const start = text.indexOf(HEADER_BLOCK.begin);
    if (start === -1) return null;
    const end = text.indexOf(HEADER_BLOCK.end, start);
    if (end === -1) return null;
    return {
        format:    text.slice(start + HEADER_BLOCK.begin.length, end).trim(),
        fullMatch: text.slice(start, end + HEADER_BLOCK.end.length),
    };
}

function stripHeaderBlock(text, fullMatch) {
    return text.replace(fullMatch, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Message handler ──────────────────────────────────────────────────────────

async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const { chat, messageFormatting } = SillyTavern.getContext();
    const message = chat[messageId];
    if (!message || message.is_user) return;

    let messageText = message.mes;
    const chatState = getChatState();

    // Check for HEADER_FORMAT block in this message
    const formatBlock = extractHeaderFormat(messageText);
    if (formatBlock) {
        chatState.format = formatBlock.format;
        await saveChatState();
        messageText = stripHeaderBlock(messageText, formatBlock.fullMatch);
        console.log(`[${MODULE_NAME}] Header format updated.`);
    }

    // Determine which format to use
    const format = (settings.useFormatBlock && chatState.format)
        ? chatState.format
        : settings.manualFormat;

    if (!format) return;
    if (!settings.showOnEveryMsg && !formatBlock) return;

    const charState = getCharState();
    const rendered  = renderHeader(format, charState);
    if (!rendered) return;

    // Build separator line
    const sep = settings.separator ? `\n${settings.separator}\n` : '\n';

    // Prepend header to message
    message.mes = rendered + sep + messageText;

    // Re-render in DOM
    const $el = $(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if ($el.length && messageFormatting) {
        $el.html(messageFormatting(
            message.mes, message.name, message.is_system, message.is_user, messageId
        ));
    }
}

// ─── Settings UI ─────────────────────────────────────────────────────────────

async function renderSettingsPanel() {
    const settings = getSettings();
    const html = `
<div class="gnh-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>GM Narrative Header</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="gnh-row"><input type="checkbox" id="gnh-enabled" ${settings.enabled?'checked':''}><span>Enable narrative header</span></label>
      <label class="gnh-row"><input type="checkbox" id="gnh-every-msg" ${settings.showOnEveryMsg?'checked':''}><span>Prepend to every GM message</span></label>
      <label class="gnh-row"><input type="checkbox" id="gnh-use-format-block" ${settings.useFormatBlock?'checked':''}><span>Use format from [HEADER_FORMAT] block (when present)</span></label>

      <div class="gnh-field">
        <label for="gnh-separator">Header / message separator</label>
        <input type="text" id="gnh-separator" class="text_pole" value="${settings.separator}" placeholder="--- or === or leave blank">
        <small>Line drawn between the header and the GM's narration.</small>
      </div>

      <div class="gnh-field">
        <label for="gnh-manual-format">Manual format (fallback)</label>
        <textarea id="gnh-manual-format" class="text_pole" rows="5" placeholder="HP: {hp}/{hp_max}  MP: {mp}/{mp_max}&#10;Conditions: {conditions}  Time: {time}">${settings.manualFormat}</textarea>
        <small>Used when no HEADER_FORMAT block is set for this chat. Use {field_key} tokens.</small>
      </div>

      <div class="gnh-info">
        <b>Token reference:</b><br>
        <code>{name}</code> <code>{class}</code> <code>{background}</code> <code>{rank}</code> — identity &amp; rank<br>
        <code>{field_key}</code> — any schema field (or needs-meter) value<br>
        <code>{field_key_max}</code> — maximum (schema max_field or meter max)<br>
        <code>{field_key_regen}</code> — regen rate per minute (signed)<br>
        <code>{field_key_pct}</code> — needs-meter percentage<br>
        <code>{time}</code> / <code>{date}</code> — in-world datetime<br>
        <code>{conditions}</code> — active conditions (comma-joined)<br>
        <code>{inventory_count}</code> / <code>{inventory_max}</code> — inventory<br>
        <code>{active_title}</code> <code>{titles}</code> <code>{boons}</code> <code>{abilities}</code> — capabilities<br>
        <code>{currency}</code> / <code>{currency:gold}</code> — coin<br>
        <code>{reputation:Faction}</code> — standing &amp; tier<br>
        <code>{skill_score:SkillName}</code> — calculated skill score<br>
        <code>{xp_next}</code> — XP to next level
      </div>
    </div>
  </div>
</div>`;

    $('#extensions_settings2').append(html);
    const save = () => SillyTavern.getContext().saveSettingsDebounced();

    $('#gnh-enabled').on('change',          function() { getSettings().enabled        = this.checked; save(); });
    $('#gnh-every-msg').on('change',         function() { getSettings().showOnEveryMsg = this.checked; save(); });
    $('#gnh-use-format-block').on('change',  function() { getSettings().useFormatBlock = this.checked; save(); });
    $('#gnh-separator').on('change',         function() { getSettings().separator      = this.value;   save(); });
    $('#gnh-manual-format').on('change',     function() { getSettings().manualFormat   = this.value;   save(); });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

jQuery(async () => {
    const { eventSource, event_types } = SillyTavern.getContext();
    getSettings();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.APP_READY, async () => {
        await renderSettingsPanel();
    });

    console.log(`[${MODULE_NAME}] v${VERSION} loaded.`);
});
