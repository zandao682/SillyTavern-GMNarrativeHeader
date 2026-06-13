/**
 * GM Narrative Header — SillyTavern Extension  v1.0.0
 *
 * Prepends a formatted status header to every GM (AI) message.
 * The header is populated from gm-lore-parser's character state in chatMetadata.
 *
 * Format is controlled by a template string where tokens like {hp}, {mp},
 * {name}, {time} etc. are replaced with live values.
 *
 * Systems define their own format via a [HEADER_FORMAT_BEGIN] block emitted
 * by the GM or Architect card. The format persists in chatMetadata.
 *
 * Example Veridia header template:
 *   Name: {name}   Rank: {creature_rank}
 *   Race: {race}   Level: {level}   XP: {xp}/{xp_next}
 *   Date: {date}   Time: {time}
 *   HP: {hp}/{hp_max} ({hp_regen}/min)   MP: {mp}/{mp_max} ({mp_regen}/min)   Vigor: {vigor}/{vigor_max} ({vigor_regen}/min)
 *   Fatigue: {fatigue}%   Hunger: {hunger}%   Thirst: {thirst}%
 *   Status: {conditions}   Inventory: {inventory_count}/{inventory_max} Slots Used
 *
 * Tokens:
 *   {field_key}           — value of that field from character state
 *   {field_key_max}       — max value of that field (from max_field in schema)
 *   {field_key_regen}     — regen rate per minute for that field
 *   {time}                — world_time.display
 *   {date}                — world_time.display (alias)
 *   {inventory_count}     — number of items in inventory
 *   {inventory_max}       — max inventory slots (if defined in schema)
 *   {conditions}          — comma-joined conditions list or "None"
 *   {skill_score:SkillName} — skill score for a named skill (from gm-lore-parser)
 *
 * The header is prepended to the AI message text so it appears in-narrative.
 * It can be toggled per-conversation or globally.
 */

const MODULE_NAME = 'gm-narrative-header';
const VERSION     = '1.0.0';
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

function resolveToken(token, charState) {
    if (!charState) return `{${token}}`;
    const values = charState.values || {};
    const schema = charState.schema?.fields || {};
    const ss     = charState.skill_system;

    // Special tokens
    if (token === 'time' || token === 'date')
        return charState.world_time?.display || '—';

    if (token === 'conditions')
        return (Array.isArray(values.conditions) && values.conditions.length)
            ? values.conditions.join(', ') : 'None';

    if (token === 'inventory_count')
        return Array.isArray(values.inventory) ? values.inventory.length : 0;

    if (token === 'inventory_max') {
        // Look for a schema field named inventory_max or similar
        return values.inventory_max || values.bag_slots || '?';
    }

    // Skill score: {skill_score:Swordsmanship}
    if (token.startsWith('skill_score:') && ss) {
        const skillName = token.slice(12).trim().toLowerCase().replace(/\s+/g,'-');
        const skill     = ss.skills?.[skillName];
        if (!skill) return '?';
        const totalLevels = Object.values(ss.skills).reduce((acc, s) => acc + (s.tier_idx * (ss.levels_per_tier||10) + s.level + 1), 0);
        try {
            const formula = (ss.score_formula || '10 + total_levels * 2.5').replace(/total_levels/g, totalLevels);
            if (/^[\d\s\+\-\*\/\(\)\.]+$/.test(formula))
                return Math.round(Function(`"use strict"; return (${formula})`)());
        } catch {}
        return '?';
    }

    // _regen suffix
    if (token.endsWith('_regen')) {
        const baseKey = token.slice(0, -6);
        const desc    = schema[baseKey];
        return formatRegen(regenPerMinute(desc));
    }

    // _max suffix (find via max_field reference)
    if (token.endsWith('_max')) {
        const baseKey = token.slice(0, -4);
        // Direct value
        if (values[token] !== undefined) return values[token];
        // From schema max_field
        const desc = schema[baseKey];
        if (desc?.max_field) return values[desc.max_field] ?? '?';
        return '?';
    }

    // xp_next — XP needed for next level (system must define this or GM sets it)
    if (token === 'xp_next') return values.xp_next ?? values.xp_to_next_level ?? '?';

    // Direct field lookup
    if (values[token] !== undefined) {
        const v = values[token];
        return Array.isArray(v) ? v.join(', ') : v;
    }

    // Not found
    return `{${token}}`;
}

function renderHeader(format, charState) {
    if (!format) return null;
    // Replace all {token} patterns
    return format.replace(/\{([^}]+)\}/g, (_, token) => resolveToken(token.trim(), charState));
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
        <code>{field_key}</code> — any schema field value<br>
        <code>{field_key_max}</code> — field maximum<br>
        <code>{field_key_regen}</code> — regen rate per minute<br>
        <code>{time}</code> or <code>{date}</code> — in-world datetime<br>
        <code>{conditions}</code> — active conditions (comma-joined)<br>
        <code>{inventory_count}</code> — items in inventory<br>
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
