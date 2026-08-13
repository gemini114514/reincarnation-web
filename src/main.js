import './style.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import jquery from 'jquery';
import * as Vue from 'vue';
import * as Zod from 'zod';
import { GameStore, getAffection } from './store.js';
import { CardRuntime } from './runtime.js';
import { library, normalizePreset, normalizeScript, normalizeRegexPreset } from './library.js';
import { GameplayBlackBox } from './blackbox.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const LIFE_LEVEL_ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ'];
const ASCII_LIFE_LEVEL_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
function normalizeLifeLevel(value) {
    const text = String(value ?? '').trim().toUpperCase();
    const romanIndex = LIFE_LEVEL_ROMAN.indexOf(text);
    if (romanIndex >= 0) return romanIndex + 1;
    const asciiIndex = ASCII_LIFE_LEVEL_ROMAN.indexOf(text);
    if (asciiIndex >= 0) return asciiIndex + 1;
    const numeric = Number(text);
    // The card has exactly nine life levels; legacy 1–50 values are invalid.
    return Number.isInteger(numeric) && numeric >= 1 && numeric <= 9 ? numeric : 1;
}
function lifeLevelRoman(value) { return LIFE_LEVEL_ROMAN[normalizeLifeLevel(value) - 1] || LIFE_LEVEL_ROMAN[0]; }
function heroLifeLevel(hero = {}) { return normalizeLifeLevel(hero.层级 ?? hero.位阶 ?? hero.等级 ?? 1); }
const store = new GameStore();
const blackbox = new GameplayBlackBox();
let runtime;
let generating = false;
let generationController = null;
let generationClock = null;
let activeMessageId = null;
let presets = [];
let scripts = [];
let profiles = [];
let regexPresets = [];
let openingData = null;
let selectedStarterIds = new Set();
let customStarterItems = [];
let selectedPlotId = null;
let selectedPresetId = null;
let selectedScriptId = null;
let selectedRegexPresetId = 'card';
let selectedPromptEntryId = null;
let selectedRegexEntryId = null;
const scriptFrames = new Map();
let connectionModelCandidates = [];
let textEditorOriginal = '';
let textEditorSave = null;
let textEditorSearchAt = 0;
let textEditorMode = 'json';
let textEditorReadonly = false;
let setupShopCategory = 'all';
let setupShopRarity = 'all';
let personalShopCategory = 'all';
let personalShopRarity = 'all';
let personalShopSearch = '';
let personalShopExtraRequirement = '';
let personalShopRefreshBusy = false;
let personalShopRefreshAbort = null;
let personalShopRefreshStartedAt = 0;
let personalShopRefreshStatus = '';
let personalShopRefreshTimer = null;
const storyFloorBySession = new Map();
let combatState = null;
let combatEvents = [];
let combatShowCohorts = false;
let combatBusy = false;
let pendingCombatScriptReview = null;

window.addEventListener('error', event => blackbox.record('error', 'window_error', { message: event.message, source: event.filename, line: event.lineno, column: event.colno, error: event.error }));
window.addEventListener('unhandledrejection', event => blackbox.record('error', 'unhandled_rejection', { reason: event.reason }));

marked.setOptions({ breaks: true, gfm: true });

function toast(message, type = 'info') {
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    $('#toasts').append(item);
    setTimeout(() => item.remove(), 4200);
}

function formatTime(value) {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML;
}

function renderRich(container, source, messageId, role = 'assistant') {
    container.replaceChildren();
    if (source.trim() === '【封面】') {
        container.innerHTML = `<div class="native-cover"><span class="cover-tag">REINCARNATION PROTOCOL · 3.2.6</span><h2>轮回战场</h2><p>一套以 D100 判定、数值化战斗和动态因果为核心的无限世界生存协议。</p><div class="cover-features"><div><b>D100 物理演算</b><small>属性、装甲与血量双轨裁定</small></div><div><b>因果演进</b><small>你的选择持续改变世界稳定度</small></div><div><b>升维与降解</b><small>跨世界战利品与生命层级体系</small></div><div><b>动态生态</b><small>NPC 拥有立场、记忆与利益诉求</small></div></div><label><input type="checkbox" data-cover-agree> 我已了解规则，准备建立轮回者档案</label><button disabled data-action="enter-game">接入主神终端</button></div>`;
        return;
    }
    if (source.trim() === '【开局】') {
        container.innerHTML = `<div class="setup-launcher"><div class="setup-icon">+</div><div><h3>建立轮回者档案</h3><p>录入身份、血统潜质、背景和初始投放方式，然后开始第一场轮回。</p></div><button data-action="open-setup">开始建档</button></div>`;
        return;
    }
    let content = String(source)
        .replace(/<dm_think>[\s\S]*?<\/dm_think>/gi, '')
        .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, match => `<details class="variable-log"><summary>本轮状态已更新</summary><pre>${escapeHtml(match)}</pre></details>`);

    content = content.replace(/<CheckResult>([\s\S]*?)<\/CheckResult>/gi, (_all, check) => `<div class="native-check"><header><span>◆ D100 行动检定</span><span>判定完成</span></header>${marked.parse(check)}</div>`);
    content = content.replace(/<options>([\s\S]*?)<\/options>/gi, (_all, options) => {
        const lines = options.split('\n').map(line => line.trim()).filter(Boolean);
        return `<div class="native-options">${lines.map(line => `<button data-native-prompt="${escapeHtml(line.replace(/^\d+[.、]\s*/, ''))}">${escapeHtml(line)}</button>`).join('')}</div>`;
    });
    content = content.replace(/<mission>([\s\S]*?)<\/mission>/gi, (_all, mission) => {
        const worlds = parseWorldCandidates(mission);
        return `<div class="world-choices">${worlds.map(world => `<article class="world-choice"><h4>${escapeHtml(world.title)}</h4><p>${escapeHtml(world.description)}</p><button data-native-prompt="${escapeHtml(`我选择进入${world.title}。${world.description}`)}">选择此世界</button></article>`).join('')}</div>`;
    });
    content = runtime?.applyExternalDisplayRegex(content, role) ?? content;
    appendMarkdown(container, content);
}

function parseWorldCandidates(source) {
    const blocks = String(source).split(/(?=\d*[.、]?\s*【[^】]+】)/).map(item => item.trim()).filter(Boolean);
    return blocks.map((block, index) => {
        const title = block.match(/【([^】]+)】/)?.[1] ?? `候选世界 ${index + 1}`;
        return { title, description: block.replace(/^\d*[.、]?\s*【[^】]+】/, '').trim().slice(0, 500) };
    });
}

function appendMarkdown(container, source) {
    if (!source.trim()) return;
    const part = document.createElement('div');
    part.innerHTML = DOMPurify.sanitize(marked.parse(source), { ADD_TAGS: ['details', 'summary'], ADD_ATTR: ['open'] });
    while (part.firstChild) container.append(part.firstChild);
}

function collectStoryFloors(messages) {
    const floors = [];
    let actions = [];
    for (const message of messages.filter(item => !item.isHidden)) {
        if (message.role === 'user') { actions.push(message); continue; }
        floors.push({ id: message.id, narrative: message, actions });
        actions = [];
    }
    if (actions.length) floors.push({ id: actions.at(-1).id, narrative: null, actions });
    return floors;
}

function currentStoryFloor() {
    const session = store.activeSession;
    if (!session) return null;
    const floors = collectStoryFloors(session.messages);
    const index = Math.max(0, Math.min(floors.length - 1, storyFloorBySession.get(session.id) ?? floors.length - 1));
    return floors[index] || null;
}

function renderMessages({ followLatest = false } = {}) {
    const list = $('#messages');
    list.replaceChildren();
    const session = store.activeSession;
    if (!session) return;
    const floors = collectStoryFloors(session.messages);
    const previous = storyFloorBySession.get(session.id);
    let floorIndex = followLatest || previous === undefined ? floors.length - 1 : previous;
    floorIndex = Math.max(0, Math.min(floors.length - 1, floorIndex));
    storyFloorBySession.set(session.id, floorIndex);
    const floor = floors[floorIndex];
    if (floor) {
        const message = floor.narrative || floor.actions.at(-1);
        const node = document.createElement('article');
        node.className = `story-floor-card message ${message.role}`;
        node.dataset.id = message.id;
        const actionText = floor.actions.map(item => item.content).join('\n\n');
        node.innerHTML = `<header class="story-floor-heading"><div><small>STORY FLOOR</small><b>第 ${floorIndex + 1} 楼</b></div><span>${formatTime(message.createdAt)}</span></header>${actionText ? `<section class="floor-action"><small>${escapeHtml(store.data.settings.userName || '轮回者')}的行动</small><p>${escapeHtml(actionText)}</p></section>` : ''}<div class="message-body story-narrative"></div>`;
        list.append(node);
        renderRich($('.message-body', node), message.content, message.id, message.role);
        activeMessageId = message.id;
    } else list.innerHTML = '<div class="empty-state">尚无剧情楼层</div>';
    const previousButton = $('[data-action="floor-prev"]');
    const nextButton = $('[data-action="floor-next"]');
    previousButton.disabled = floorIndex <= 0;
    nextButton.disabled = floorIndex >= floors.length - 1;
    const usage = floor?.narrative?.tokenUsage;
    $('#floorTokenUsage').textContent = usage ? `Token ${Number(usage.totalTokens || 0).toLocaleString()}${usage.exact ? '' : ' ≈'}` : 'Token —';
    $('#floorTokenUsage').disabled = !usage;
    $('#floorPromptButton').disabled = !floor?.narrative?.promptTrace;
    $('[data-action="edit-floor"]').disabled = !floor;
    $('[data-action="regen-floor"]').disabled = !floor?.narrative;
    $('[data-action="delete-floor"]').disabled = !floor;
    $('#tokenBadge').textContent = floors.length ? `${floorIndex + 1} / ${floors.length} 楼` : '0 楼';
    $('#sessionTitle').textContent = session.title;
    list.scrollTop = 0;
}

function readSseText(buffer, onChunk, onEvent = () => {}) {
    const events = buffer.split('\n\n');
    const rest = events.pop() ?? '';
    for (const event of events) {
        for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
                const json = JSON.parse(data);
                const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.text ?? '';
                if (delta) onChunk(delta);
                onEvent(json);
            } catch { /* incomplete or provider metadata event */ }
        }
    }
    return rest;
}

function estimateTokens(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    return Math.max(0, Math.ceil(cjk * 1.15 + (text.length - cjk) / 3.8));
}

function normalizeTokenUsage(usage, promptMessages, output) {
    const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokenCount ?? usage?.inputTokens);
    const completion = Number(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.candidatesTokenCount ?? usage?.outputTokens);
    const total = Number(usage?.total_tokens ?? usage?.totalTokenCount ?? usage?.totalTokens);
    const exact = Number.isFinite(input) || Number.isFinite(completion) || Number.isFinite(total);
    const inputTokens = Number.isFinite(input) ? input : estimateTokens(promptMessages);
    const outputTokens = Number.isFinite(completion) ? completion : estimateTokens(output);
    return { inputTokens, outputTokens, totalTokens: Number.isFinite(total) ? total : inputTokens + outputTokens, exact, raw: usage || null };
}

async function generate({ addUser = true, text = '' } = {}) {
    if (generating) return;
    const settings = store.data.settings;
    if (!settings.baseUrl || !settings.model) {
        showPanel('settings');
        toast('请先填写 API 地址和模型名称', 'error');
        return;
    }
    if (addUser) {
        const value = text.trim();
        if (!value) return;
        store.addMessage('user', value);
    }
    const session = store.activeSession;
    const prompt = runtime.buildPrompt(session.messages);
    const assistant = store.addMessage('assistant', '');
    for (const message of session.messages) if (message !== assistant) delete message.promptTrace;
    assistant.promptTrace = {
        sentAt: new Date().toISOString(), model: settings.model, protocol: settings.protocol || 'openai-chat',
        preset: runtime.activePreset ? { id: runtime.activePreset.id, name: runtime.activePreset.name } : null,
        activeWorldbookEntries: prompt.activeEntries.map(item => item.comment || item.name || item.uid),
        messages: structuredClone(prompt.messages),
    };
    assistant.tokenUsage = normalizeTokenUsage(null, prompt.messages, '');
    store.save();
    const turnId = crypto.randomUUID();
    const startedAt = performance.now();
    const variablesBefore = structuredClone(runtime.variables);
    await blackbox.record('turn', 'generation_started', {
        addUser, userText: text, messageCount: session.messages.length, prompt,
        preset: runtime.activePreset ? { id: runtime.activePreset.id, name: runtime.activePreset.name, prompts: runtime.activePreset.prompts?.length } : null,
        connection: settings, variablesBefore,
    }, { sessionId: session.id, turnId });
    generating = true;
    generationController = new AbortController();
    let timeoutId;
    const armGenerationTimeout = phase => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => generationController?.abort(new DOMException(`${phase}连续 300 秒无响应`, 'TimeoutError')), 300000);
    };
    armGenerationTimeout('等待上游');
    generationClock = setInterval(() => {
        const seconds = Math.floor((performance.now() - startedAt) / 1000);
        if ($('#generationElapsed')) $('#generationElapsed').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }, 1000);
    $('#generationElapsed').textContent = '0:00'; $('#generationChars').textContent = '等待首包';
    $('#sendButton').disabled = true;
    $('#typing').classList.remove('hidden');
    renderMessages({ followLatest: true });
    try {
        const sampling = runtime.activePreset?.sampling ?? {};
        const requestPayload = { ...settings, ...sampling, maxTokens: Math.max(30000, Number(sampling.maxTokens || settings.maxTokens) || 32768), assistantPrefill: runtime.activePreset?.assistantPrefill || '', messages: prompt.messages };
        await blackbox.record('api', 'request_dispatched', { url: '/api/chat', payload: requestPayload }, { sessionId: session.id, turnId });
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload),
            signal: generationController.signal,
        });
        armGenerationTimeout('接收响应');
        await blackbox.record('api', 'response_headers', { status: response.status, ok: response.ok, contentType: response.headers.get('content-type'), elapsedMs: Math.round(performance.now() - startedAt) }, { sessionId: session.id, turnId });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `HTTP ${response.status}`);
        }
        const type = response.headers.get('content-type') || '';
        if (type.includes('application/json')) {
            const body = await response.json();
            assistant.content = body.choices?.[0]?.message?.content ?? '';
            assistant.tokenUsage = normalizeTokenUsage(body.usage, prompt.messages, assistant.content);
            store.updateMessage(assistant.id, assistant.content);
        } else {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let content = '';
            let streamUsage = null;
            let firstChunkRecorded = false;
            let lastPaint = 0;
            while (true) {
                const { value, done } = await reader.read();
                armGenerationTimeout('流式传输');
                buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
                buffer = readSseText(buffer, chunk => { content += chunk; }, event => { if (event.usage) streamUsage = event.usage; });
                if (content && !firstChunkRecorded) { firstChunkRecorded = true; blackbox.record('api', 'response_first_chunk', { elapsedMs: Math.round(performance.now() - startedAt) }, { sessionId: session.id, turnId }); }
                $('#generationChars').textContent = `${content.length.toLocaleString()} 字`;
                const now = performance.now();
                if (now - lastPaint > 90 || done) {
                    assistant.content = content;
                    const body = $(`.message[data-id="${assistant.id}"] .message-body`);
                    if (body) renderRich(body, content, assistant.id);
                    $('#messages').scrollTop = $('#messages').scrollHeight;
                    lastPaint = now;
                }
                if (done) break;
            }
            assistant.tokenUsage = normalizeTokenUsage(streamUsage, prompt.messages, content);
            store.updateMessage(assistant.id, content);
        }
        const updated = await runtime.parseVariableUpdate(assistant.content, runtime.variables);
        const variablesChanged = JSON.stringify(updated) !== JSON.stringify(runtime.variables);
        if (variablesChanged) await runtime.replaceVariables(updated);
        if (!/<UpdateVariable>/i.test(assistant.content)) await blackbox.record('runtime', 'variable_update_absent', { variablesChanged, responseLength: assistant.content.length }, { sessionId: session.id, turnId });
        await runtime.emit('message_received', session.messages.length - 1);
        await runtime.emit('character_message_rendered', session.messages.length - 1);
        await blackbox.record('turn', 'generation_completed', { elapsedMs: Math.round(performance.now() - startedAt), response: assistant.content, variablesBefore, variablesAfter: runtime.variables }, { sessionId: session.id, turnId });
    } catch (error) {
        const detail = generationController?.signal.aborted ? (generationController.signal.reason?.message || '用户已中止') : error.message;
        assistant.tokenUsage = normalizeTokenUsage(null, prompt.messages, assistant.content);
        store.updateMessage(assistant.id, `> 连接中断\n\n${detail}`);
        toast(`生成失败：${detail}`, 'error');
        await blackbox.record('turn', 'generation_failed', { elapsedMs: Math.round(performance.now() - startedAt), error, partialResponse: assistant.content }, { sessionId: session.id, turnId });
    } finally {
        clearTimeout(timeoutId); clearInterval(generationClock); generationClock = null; generationController = null;
        generating = false;
        $('#sendButton').disabled = false;
        $('#typing').classList.add('hidden');
        renderAll();
        renderBlackBox();
    }
}

function triggerSlash(command) {
    const input = $('#messageInput');
    const send = String(command).match(/^\/send\s+([\s\S]*?)(?:\|\/trigger)?$/i);
    if (send) {
        const text = send[1].replace(/\\\|/g, '|').trim();
        input.value = text;
        input.dispatchEvent(new Event('input'));
        generate({ text });
        return true;
    }
    const setInput = String(command).match(/^\/(?:setinput|input)\s+([\s\S]*)$/i);
    if (setInput) {
        input.value = setInput[1];
        input.dispatchEvent(new Event('input'));
        input.focus();
        return true;
    }
    if (/^\/trigger/i.test(command)) return true;
    return false;
}

function installBridge() {
    const messages = () => store.activeSession?.messages ?? [];
    window.getChatMessages = (range, options = {}) => {
        let selected = messages();
        if (range !== undefined && range !== null && range !== '') {
            const id = String(range);
            selected = selected.filter((item, index) => item.id === id || String(index) === id);
        }
        return selected.map((item, index) => ({
            message_id: item.id,
            message: item.content,
            role: item.role,
            is_user: item.role === 'user',
            swipes: options.include_swipe ? item.swipes : undefined,
            swipe_id: item.swipeIndex,
            is_hidden: Boolean(item.isHidden),
            index,
        }));
    };
    window.setChatMessage = async (content, messageId, options = {}) => {
        const all = messages();
        const message = all.find((item, index) => item.id === String(messageId) || String(index) === String(messageId));
        if (!message) throw new Error('未找到消息');
        if (typeof options.is_hidden === 'boolean') message.isHidden = options.is_hidden;
        if (Number.isInteger(options.swipe_id) && message.swipes?.[options.swipe_id] !== undefined) {
            message.swipeIndex = options.swipe_id;
            message.content = message.swipes[options.swipe_id];
        } else if (content !== undefined && content !== null) {
            message.content = String(content);
        }
        store.save();
        renderMessages();
        return true;
    };
    window.setChatMessages = async updates => {
        for (const update of Array.isArray(updates) ? updates : [updates]) {
            const id = update.message_id ?? update.id ?? update.index;
            await window.setChatMessage(update.message ?? update.content, id, update);
        }
        return true;
    };
    window.injectPrompts = prompts => runtime.injectPrompts(prompts);
    window.triggerSlash = triggerSlash;
    window.__reincarnationBridge = {
        getChatMessages: window.getChatMessages,
        setChatMessage: window.setChatMessage,
        setChatMessages: window.setChatMessages,
        injectPrompts: window.injectPrompts,
        triggerSlash,
        getMessageVar: (...args) => window.getMessageVar(...args),
        setMessageVar: (...args) => window.setMessageVar(...args),
    };
    window.addEventListener('message', event => {
        if (event.data?.type === 'world_selection' && event.data.content) generate({ text: event.data.content });
    });
}

function renderStatus() {
    const stat = runtime.variables.stat_data ?? {};
    const player = stat['主角'] ?? {};
    const system = stat['系统状态'] ?? {};
    const world = stat['世界'] ?? {};
    const cards = [
        ['生命层级', player['层级'] ?? 'Ⅰ'],
        ['HP', `${player.HP ?? 20} / ${player.HP_MAX ?? 20}`, Number(player.HP || 0) / Math.max(1, Number(player.HP_MAX || 20))],
        ['EP', `${player.EP ?? 0} / ${player.EP_MAX ?? 0}`, Number(player.EP || 0) / Math.max(1, Number(player.EP_MAX || 1))],
        ['空间币', player['空间币'] ?? 0],
        ['当前位置', world['地点'] || world['名称'] || '主神空间'],
        ['世界稳定', `${world['稳定'] ?? 100}%`, Number(world['稳定'] ?? 100) / 100],
        ['战斗状态', system['是否战斗中'] ? `第 ${system['当前轮次'] ?? 1} 回合` : '非战斗'],
        ['当前形态', player['当前形态']?.['名称'] || '基础形态'],
    ];
    const node = $('#statusContent');
    node.innerHTML = cards.map(([name, value, progress]) => `<article class="stat-card"><small>${escapeHtml(name)}</small><strong>${escapeHtml(value)}</strong>${progress !== undefined ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, progress * 100))}%"></i></div>` : ''}</article>`).join('');
    const attributes = player['最终属性'] ?? {};
    const equipment = player['装备'] ?? {};
    node.insertAdjacentHTML('beforeend', `<article class="stat-card wide"><small>最终属性</small>${dataTable(attributes)}</article><article class="stat-card wide"><small>装备</small>${dataTable(equipment)}</article><article class="stat-card full"><small>状态效果</small>${dataTable(player['状态'] ?? {})}</article>`);
}

function plainValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (Array.isArray(value)) return value.join('、') || '—';
    if (typeof value === 'object') return value['描述'] || value['名称'] || JSON.stringify(value);
    return String(value);
}

function entityCards(collection, type) {
    const entries = Array.isArray(collection) ? collection.map((value, index) => [value?.['名称'] || `${type} ${index + 1}`, value]) : Object.entries(collection || {});
    if (!entries.length) return `<div class="empty-state">暂无${escapeHtml(type)}记录</div>`;
    return entries.map(([name, data]) => {
        const obj = typeof data === 'object' && data ? data : { '描述': data };
        const tier = obj['品质'] || obj['层级'] || obj['等级'] || obj['位格'] || '—';
        const description = obj['描述'] || obj['效果'] || obj['背景'] || obj['状态'] || plainValue(data);
        const tags = obj['标签'] || obj['类型'] || obj['身份'] || [];
        const tagList = Array.isArray(tags) ? tags : [tags];
        return `<article class="entity-card" data-entity-type="${escapeHtml(type)}"><header><h3>${escapeHtml(name)}</h3><span class="tier">${escapeHtml(tier)}</span></header><p>${escapeHtml(plainValue(description))}</p><footer>${tagList.filter(Boolean).slice(0, 6).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</footer></article>`;
    }).join('');
}

function renderInventory() {
    const stat = runtime.variables.stat_data ?? {};
    const player = stat['主角'] ?? {};
    $('#inventoryContent').innerHTML = `${entityCards(player['装备'], '装备')}${entityCards(player['道具'], '道具')}${entityCards(stat['资产'], '资产')}`;
}

function renderAbilities() {
    const player = runtime.variables.stat_data?.['主角'] ?? {};
    const sections = [['职业', player['职业']], ['血统', player['血统']], ['技能', player['技能']], ['形态库', player['形态库']]];
    $('#abilityContent').innerHTML = sections.map(([title, data]) => `<section class="entity-section"><h2>${title}</h2><div class="entity-grid">${entityCards(data, title)}</div></section>`).join('');
}

function dataTable(value) {
    const entries = Object.entries(value || {});
    if (!entries.length) return '<p style="color:#5e6979;font-size:12px">暂无数据</p>';
    return `<table class="data-table">${entries.slice(0, 30).map(([key, item]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(typeof item === 'object' ? JSON.stringify(item) : item)}</td></tr>`).join('')}</table>`;
}

function renderMissions() {
    const stat = runtime.variables.stat_data ?? {};
    const missions = stat['任务']?.['列表'] ?? {};
    const world = stat['世界'] ?? {};
    const items = Object.entries(missions);
    $('#missionCount').textContent = items.length;
    $('#missionContent').innerHTML = items.map(([name, data]) => { const obj = typeof data === 'object' ? data : { '描述': data }; const progress = Number(obj['进度'] || 0); return `<article class="mission-card"><h3>${escapeHtml(name)}</h3><p>${escapeHtml(plainValue(obj['描述'] || obj['目标'] || data))}</p><p>状态：${escapeHtml(obj['状态'] || '进行中')} · 奖励：${escapeHtml(plainValue(obj['奖励']))}</p>${progress ? `<progress max="100" value="${Math.min(100, progress)}"></progress>` : ''}</article>`; }).join('') || '<div class="empty-state">尚未接受任务。前往冒险记录或请求新的世界候选。</div>';
}

function renderWorld() {
    const world = runtime.variables.stat_data?.['世界'] ?? {};
    const tags = value => `<div class="tag-cloud">${(Array.isArray(value) ? value : Object.keys(value || {})).map(item => `<span>${escapeHtml(item)}</span>`).join('') || '<span>暂无记录</span>'}</div>`;
    $('#worldContent').innerHTML = `<article class="world-panel"><h3>${escapeHtml(world['名称'] || '主神空间')}</h3>${dataTable({ '当前位置': world['地点'], '世界位格': world['位格'], '任务难度': world['难度'], '稳定度': `${world['稳定'] ?? 100}%`, '世界时间': world['时间'] })}</article><article class="world-panel"><h3>世界法则</h3>${tags(world['法则'])}</article><article class="world-panel full"><h3>势力</h3>${dataTable(world['势力'] || {})}</article><article class="world-panel"><h3>探索记录</h3>${dataTable(world['探索'] || {})}</article><article class="world-panel"><h3>因果轨道</h3>${dataTable(world['因果轨道'] || {})}</article>`;
}

function renderRelations() {
    const stat = runtime.variables.stat_data ?? {};
    const relations = stat['关系列表'] ?? {};
    const names = ['主角', ...Object.keys(relations)];
    const displayName = name => name === '主角' ? (stat['主角']?.['姓名'] || store.data.settings.userName || '主角') : name;
    const tone = score => score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
    const matrix = names.length > 1 ? `<section class="relation-matrix-panel"><header><div><small>DIRECTED AFFECTION</small><h2>互相好感度</h2></div><p>纵轴对横轴的好感；未记录统一按 0 处理。</p></header><div class="relation-matrix-scroll"><table class="relation-matrix"><thead><tr><th>由 \ 对</th>${names.map(name => `<th>${escapeHtml(displayName(name))}</th>`).join('')}</tr></thead><tbody>${names.map(source => `<tr><th>${escapeHtml(displayName(source))}</th>${names.map(target => source === target ? '<td class="self">—</td>' : `<td class="${tone(getAffection(stat, source, target))}" title="${escapeHtml(displayName(source))} → ${escapeHtml(displayName(target))}">${getAffection(stat, source, target)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>` : '';
    const cards = Object.entries(relations).map(([name, npc]) => {
        const relationEntries = Object.entries(npc?.['好感度关系'] || {}).filter(([target]) => target !== name);
        const relationList = relationEntries.length ? relationEntries.map(([target, score]) => `<li><span>→ ${escapeHtml(displayName(target))}</span><b class="${tone(Number(score) || 0)}">${Number(score) || 0}</b></li>`).join('') : '<li class="empty-relation">未记录关系，默认均为 0</li>';
        return `<article class="relation-entity-card"><header><div><small>${npc?.['是否队友'] ? 'PARTY ENTITY' : 'WORLD ENTITY'}</small><h3>${escapeHtml(name)}</h3></div><span>${escapeHtml(npc?.['层级'] || '—')}</span></header><p>${escapeHtml(npc?.['背景故事'] || npc?.['外貌'] || npc?.['身份'] || '暂无人物摘要')}</p><h4>有向好感度</h4><ul>${relationList}</ul></article>`;
    }).join('');
    $('#relationContent').innerHTML = `${matrix}<section class="relation-entity-grid">${cards || '<div class="empty-state">暂无 NPC；空关系列表中的任意好感度均按 0 读取。</div>'}</section>`;
}

function renderIntel() {
    const intel = runtime.variables.stat_data?.['传闻'] ?? {};
    const groups = [['街头巷议', intel['街头巷议']], ['情报交易', intel['情报交易']], ['布告与檄文', intel['布告与檄文']]];
    $('#intelContent').innerHTML = groups.map(([title, data]) => `<section class="intel-column"><h3>${title}</h3>${Object.entries(data || {}).map(([name, value]) => `<div class="intel-item"><b>${escapeHtml(name)}</b><p>${escapeHtml(plainValue(value))}</p></div>`).join('') || '<div class="empty-state">暂无情报</div>'}</section>`).join('');
}

function renderHudAndHub() {
    const stat = runtime.variables.stat_data ?? {};
    const player = stat['主角'] ?? {};
    const world = stat['世界'] ?? {};
    const missions = Object.entries(stat['任务']?.['列表'] ?? {});
    const hp = Number(player.HP ?? 20), hpMax = Number(player.HP_MAX ?? 20), ep = Number(player.EP ?? 0), epMax = Number(player.EP_MAX ?? 0);
    $('#hudHp').textContent = `${hp}/${hpMax}`; $('#hudHpBar').style.width = `${Math.min(100, hp / Math.max(1, hpMax) * 100)}%`;
    $('#hudEp').textContent = `${ep}/${epMax}`; $('#hudEpBar').style.width = `${Math.min(100, ep / Math.max(1, epMax) * 100)}%`;
    $('#hudCoin').textContent = player['空间币'] ?? 0; $('#hudStability').textContent = `${world['稳定'] ?? 100}%`;
    $('#hubGreeting').textContent = `欢迎回来，${player['姓名'] || store.data.settings.userName || '轮回者'}`;
    $('#hubWorld').textContent = world['名称'] || '主神空间'; $('#hubLocation').textContent = world['地点'] || '等待投放';
    $('#adventureLocation').textContent = world['地点'] || world['名称'] || '主神空间';
    $('#hubSummary').textContent = stat['系统状态']?.['是否战斗中'] ? `战斗进行中 · 第 ${stat['系统状态']['当前轮次'] || 1} 回合` : `${world['名称'] || '主神空间'}运行稳定，等待你的下一项行动。`;
    $('#hubMission').innerHTML = missions.length ? `<h3>${escapeHtml(missions[0][0])}</h3><p>${escapeHtml(plainValue(missions[0][1]?.['描述'] || missions[0][1]))}</p>` : '<div class="objective-empty">当前没有进行中的任务</div>';
    $('#hubCharacter').innerHTML = [['生命层级', player['层级'] || 'Ⅰ'], ['身份', plainValue(player['身份'])], ['当前形态', player['当前形态']?.['名称'] || '基础形态'], ['空间币', player['空间币'] || 0]].map(([k,v]) => `<div class="glance-row"><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');
    $('#hubRecent').innerHTML = (store.activeSession?.messages ?? []).slice(-4).reverse().map(item => `<div class="recent-entry"><b>${item.role === 'user' ? store.data.settings.userName : '世界'}：</b>${escapeHtml(item.content.replace(/<[^>]+>/g, '').slice(0, 80))}</div>`).join('') || '<div class="objective-empty">暂无行动记录</div>';
}

function renderArchive() {
    $('#archiveContent').innerHTML = store.data.sessions.map(session => `<article class="archive-card ${session.id === store.data.activeSessionId ? 'active' : ''}" data-session="${session.id}"><h3>${escapeHtml(session.title)}</h3><p>${escapeHtml(session.messages.at(-1)?.content.replace(/<[^>]+>/g, '').slice(0, 100) || '尚未建立链接')}</p><footer><span>${session.messages.length} 条记录</span><span>${new Date(session.updatedAt).toLocaleString('zh-CN')}</span></footer></article>`).join('') || '<div class="empty-state">暂无轮回档案</div>';
}

function activeBattleId() { return store.activeSession?.activeBattleId || null; }

async function combatRequest(path = '', options = {}) {
    const response = await fetch(`/api/combat${path}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const text = await response.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
}

function defaultEncounter() {
    const stat = runtime.variables.stat_data || {};
    const player = stat['主角'] || {};
    const world = stat['世界'] || {};
    const attrs = player['最终属性'] || {};
    const value = (key, fallback) => Number(attrs[key] ?? player[key]) || fallback;
    return {
        storySessionId: store.activeSession?.id, mode: $('#combatMode')?.value || 'manual',
        encounter: {
            title: `${world['地点'] || world['名称'] || '未知区域'}遭遇战`, location: world['地点'] || world['名称'] || '当前区域',
            description: '由正文剧情触发的待确认遭遇。可直接编辑敌人、区域与能力。',
            zones: [{ id: 'front', name: '交战前沿', adjacent: ['rear'], capacity: 6 }, { id: 'rear', name: '后方区域', adjacent: ['front'], capacity: 12, cover: 15 }],
            combatants: [
                { id: 'protagonist', name: player['姓名'] || store.data.settings.userName || '主角', side: 'player', isPlayer: true, controller: 'player', hp: Number(player.HP ?? 20), maxHp: Number(player.HP_MAX ?? 20), ep: Number(player.EP ?? 0), maxEp: Number(player.EP_MAX ?? 0), attack: Number(player.ATK) || value('力量', 10), magicAttack: Number(player.MATK) || value('精神', 10), attackModifier: Number(player['攻击修正']) || 5, defenseDC: Number(player['防御DC']) || 50, initiativeDC: Number(player['先攻DC']) || value('敏捷', 0), armor: Number(player['物理减伤率']) || 0, resistance: Number(player['魔法减伤率']) || 0, zoneId: 'front' },
                { id: 'enemy', name: '敌对实体', side: 'enemy', controller: 'ai', count: 1, hp: 20, maxHp: 20, attack: 8, attackModifier: 3, defenseDC: 48, initiativeDC: 0, armor: 0, zoneId: 'front' },
            ],
        },
    };
}

function combatConnection() {
    const id = store.data.settings.activeCombatConnectionId || store.data.settings.activeConnectionId;
    return store.data.connections.find(item => item.id === id) || null;
}

function combatPreset() {
    const id = store.data.settings.activeCombatPresetId || store.data.settings.activePresetId;
    return presets.find(item => item.id === id) || null;
}

function extractJsonObject(text) {
    const source = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(source); } catch {}
    const start = source.indexOf('{'), end = source.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new Error('战斗 AI 未返回合法 JSON 对象');
}

async function callCombatAi(systemPrompt, userPrompt, purpose) {
    const connection = combatConnection();
    if (!connection) throw new Error('请先在战术终端选择独立战斗模型线路');
    const preset = combatPreset();
    const presetMessages = (preset?.prompts || []).filter(item => item.enabled !== false && !item.marker && item.content).map(item => ({ role: ['system', 'assistant', 'user'].includes(item.role) ? item.role : 'system', content: item.content }));
    const messages = [...presetMessages, { role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }];
    const turnId = crypto.randomUUID();
    await blackbox.record('combat-ai', `${purpose}_started`, { connection: { id: connection.id, name: connection.name, model: connection.model, protocol: connection.protocol }, preset: preset ? { id: preset.id, name: preset.name } : null, messages }, { sessionId: store.activeSession?.id, turnId });
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...connection, stream: false, maxTokens: Math.max(30000, Number(connection.maxTokens) || 0), messages }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || body.error || `HTTP ${response.status}`);
    const content = body.choices?.[0]?.message?.content || '';
    await blackbox.record('combat-ai', `${purpose}_completed`, { content, usage: body.usage }, { sessionId: store.activeSession?.id, turnId });
    return { content, usage: body.usage };
}

async function draftCombatWithAi() {
    if (combatBusy) return;
    combatBusy = true; renderCombat();
    try {
        const session = store.activeSession;
        const context = { recentStory: session?.messages?.filter(item => !item.isHidden).slice(-8).map(item => ({ role: item.role, content: item.content })), stat_data: runtime.variables.stat_data };
        const prompt = await callCombatAi('你是《轮回战场》V3.2.6 的遭遇导演。把剧情整理为 EncounterDraft JSON。只识别地点、区域、参战者、敌意、能力和可验证的初值；不得决定骰点、伤害过程、死亡或胜负。必须只输出 JSON。combatants 每项使用 id,name,side(player/enemy),controller,hp,maxHp,ep,maxEp,attack,magicAttack,attackModifier,defenseDC,initiativeDC,armor,resistance,zoneId,boss,phases,abilities；群体可用 count。zones 使用 id,name,adjacent,capacity,narrow,cover。', `当前剧情与 MVU：\n${JSON.stringify(context)}`, 'encounter_draft');
        const encounter = extractJsonObject(prompt.content);
        const payload = { storySessionId: session.id, mode: $('#combatMode').value, encounter: encounter.encounter || encounter };
        openTextEditor({ title: '战斗 AI 遭遇草案 · 本地校验前确认', value: JSON.stringify(payload, null, 2), mode: 'json', onSave: async text => { await createCombatFromEditor(text); $('#textEditorDialog').close(); } });
    } finally { combatBusy = false; renderCombat(); }
}

async function compileCombatStrategy(confirmed) {
    let compiled;
    if (!confirmed && combatConnection()) {
        const response = await callCombatAi('你是战斗策略编译器。只把玩家策略转换为 JSON，不计算战果。允许字段：priorities(nearest/weakest/boss 的排列)、preserveEpPercent、allowItems、allowFriendlyFire、retreat、reactionPolicy(auto/conserve)、takeoverTriggers([{field,operator,value}])。field 仅限 playerHpPercent/playerEpPercent/enemyDefeatedPercent/allyDying/bossPhaseChanged/round/noLegalAction。只输出 JSON。', `战场摘要：${JSON.stringify({ round: combatState.round, zones: combatState.zones, cohorts: combatState.cohorts })}\n玩家策略：${$('#combatStrategy').value}`, 'strategy_compile');
        compiled = extractJsonObject(response.content);
    }
    await mutateCombat('strategy/compile', { text: $('#combatStrategy').value, mode: $('#combatMode').value, confirmed, compiled });
}

async function loadCombat({ quiet = false } = {}) {
    const id = activeBattleId();
    if (!id) { combatState = null; combatEvents = []; renderCombat(); return; }
    try {
        const [state, ledger] = await Promise.all([combatRequest(`/${id}`), combatRequest(`/${id}/events`)]);
        combatState = state; combatEvents = ledger.events || []; renderCombat();
    } catch (error) { if (!quiet) toast(`读取战斗失败：${error.message}`, 'error'); }
}

async function mutateCombat(route, payload = {}) {
    if (!combatState || combatBusy) return;
    combatBusy = true; renderCombat();
    try {
        combatState = await combatRequest(`/${combatState.id}/${route}`, { method: 'POST', body: JSON.stringify({ commandId: crypto.randomUUID(), expectedVersion: combatState.version, ...payload }) });
        combatEvents = (await combatRequest(`/${combatState.id}/events`)).events || [];
        const system = runtime.variables.stat_data['系统状态'] ||= {};
        system['是否战斗中'] = !['completed', 'abandoned'].includes(combatState.status);
        system['当前轮次'] = combatState.round;
        await runtime.replaceVariables(runtime.variables);
        await blackbox.record('combat', `combat_${route.replace(/\W+/g, '_')}`, { battleId: combatState.id, state: combatState, latestEvents: combatEvents.slice(-20) }, { sessionId: store.activeSession?.id });
        renderCombat(); renderHudAndHub();
    } finally { combatBusy = false; renderCombat(); }
}

function renderCombat() {
    const state = combatState;
    $('#combatNavState').textContent = state ? state.status === 'completed' ? '✓' : state.round || '•' : '—';
    $('#combatStatus').textContent = state ? ({ draft: '待开始', ready: '已就绪', running: '演算中', paused: '已暂停', completed: '已完成', awaiting_script_approval: '等待脚本审批', abandoned: '已放弃', error: '错误' }[state.status] || state.status) : '未建立';
    $('#combatRound').textContent = state ? `${state.round} / v${state.version}` : '—';
    $('#combatSeed').textContent = state?.seed?.slice(0, 16) || '—';
    $('#combatSeed').title = state?.seed || '';
    $('#combatHash').textContent = state?.eventHash?.slice(0, 16) || '—';
    $('#combatHash').title = state?.eventHash || '';
    if (state) $('#combatMode').value = state.mode;
    const connectionId = store.data.settings.activeCombatConnectionId || store.data.settings.activeConnectionId || '';
    $('#combatConnection').innerHTML = `<option value="">仅用本地编译器</option>${store.data.connections.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === connectionId ? 'selected' : ''}>战斗 · ${escapeHtml(item.name || item.model)}</option>`).join('')}`;
    const presetId = store.data.settings.activeCombatPresetId || store.data.settings.activePresetId || '';
    $('#combatPreset').innerHTML = `<option value="">无额外预设</option>${presets.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === presetId ? 'selected' : ''}>战斗 · ${escapeHtml(item.name)}</option>`).join('')}`;
    if (state?.strategy?.source && document.activeElement !== $('#combatStrategy')) $('#combatStrategy').value = state.strategy.source;
    $('#combatZones').innerHTML = state?.zones?.map(zone => `<article class="combat-zone"><header><b>${escapeHtml(zone.name)}</b><span>${zone.narrow ? '狭窄' : `容量 ${zone.capacity}`}${zone.cover ? ` · 掩体 ${zone.cover}` : ''}</span></header><div>${state.combatants.filter(unit => unit.zoneId === zone.id).map(unit => `<button class="zone-unit ${unit.side} ${unit.state}" title="${escapeHtml(unit.name)}"><span>${unit.boss ? 'BOSS' : unit.side === 'player' ? 'ALLY' : 'HOSTILE'}</span><b>${escapeHtml(unit.name)}</b><i>${unit.hp}+${unit.thp} / ${unit.maxHp}</i></button>`).join('') || '<small>空区域</small>'}</div></article>`).join('') || '<div class="empty-state">创建遭遇后显示区域与单位</div>';
    const actor = state?.combatants?.find(unit => unit.id === state.activeUnitId);
    $('#combatActiveUnit').textContent = actor?.name || '—';
    const legal = state?.pauseReason?.legalActions || [];
    const currentZone = state?.zones?.find(zone => zone.id === actor?.zoneId);
    const moveControls = state?.pauseReason?.type === 'manual_turn' && state?.turnBudget?.[actor?.id]?.movement > 0 ? `<div class="combat-movement"><small>移动行动</small>${(currentZone?.adjacent || []).map(id => { const zone = state.zones.find(item => item.id === id); return `<button data-combat-move="${escapeHtml(id)}">→ ${escapeHtml(zone?.name || id)}</button>`; }).join('') || '<span>无相邻区域</span>'}</div>` : '';
    const scriptApproval = state?.pauseReason?.type === 'script_approval' ? `<div class="script-approval-card"><b>${escapeHtml(state.pauseReason.inspection?.ability?.name || state.pauseReason.abilityId)}</b><p>哈希 ${escapeHtml(state.pauseReason.inspection?.hash || '')}</p><span>权限：${escapeHtml((state.pauseReason.inspection?.capabilities || []).join('、') || '无声明式效果')}</span><div><button data-action="combat-inspect-script">运行 100 组固定种子审查</button><button data-action="combat-approve-script" ${pendingCombatScriptReview?.passed ? '' : 'disabled'}>批准此版本</button></div></div>` : '';
    const reactionControls = state?.pauseReason?.type === 'reaction_window' ? `<div class="reaction-window"><b>关键反应窗口</b><p>${escapeHtml(state.pauseReason.type)} · ${escapeHtml(state.pauseReason.unitId || '')} · 阶段 ${escapeHtml(state.pauseReason.threshold || '')}</p><div>${(state.pauseReason.options || ['policy']).map(option => `<button data-combat-reaction="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join('')}</div></div>` : '';
    $('#combatTurn').innerHTML = scriptApproval || reactionControls || (actor ? `<div class="active-unit-card"><b>${escapeHtml(actor.name)}</b><span>HP ${actor.hp}/${actor.maxHp} · EP ${actor.ep}/${actor.maxEp}</span><small>${escapeHtml(state.pauseReason?.type || '等待本地演算')}</small></div>${moveControls}${state.pauseReason?.type === 'manual_turn' ? legal.map(ability => `<div class="combat-ability"><header><b>${escapeHtml(ability.name)}</b><span>EP ${ability.epCost} · ${ability.actionType}</span></header><div>${ability.actionAvailable ? ability.legalTargetIds.map(id => { const target = state.combatants.find(unit => unit.id === id); return `<button data-combat-ability="${escapeHtml(ability.id)}" data-combat-script="${ability.scriptHash ? 'true' : 'false'}" data-combat-target="${escapeHtml(id)}">${escapeHtml(target?.name || id)}</button>`; }).join('') || '<small>无合法目标</small>' : '<small>对应行动已用尽</small>'}</div></div><button data-action="combat-wait">结束本单位回合</button>`).join('') : `<p>${escapeHtml(JSON.stringify(state.pauseReason || {}))}</p>`}` : '<div class="empty-state">等待行动时机</div>');
    const roster = combatShowCohorts ? state?.cohorts || [] : state?.combatants || [];
    $('#combatRoster').innerHTML = roster.map(unit => combatShowCohorts ? `<article><div><b>${escapeHtml(unit.name)}</b><small>${escapeHtml(unit.zoneId)} · ${escapeHtml(unit.state)}</small></div><span>×${unit.count} · HP ${unit.totalHp}/${unit.totalMaxHp}</span></article>` : `<article><div><b>${escapeHtml(unit.name)}</b><small>${escapeHtml(unit.zoneId)} · ${escapeHtml(unit.state)}${unit.boss ? ' · BOSS' : ''}</small></div><span>HP ${unit.hp}+${unit.thp}/${unit.maxHp} · EP ${unit.ep}/${unit.maxEp}</span>${unit.side === 'player' ? `<label title="切换手动/AI 控制"><input type="checkbox" data-combat-control="${escapeHtml(unit.id)}" ${unit.controller === 'player' ? 'checked' : ''}></label>` : ''}</article>`).join('') || '<div class="empty-state">暂无参战实体</div>';
    $('#combatEvents').innerHTML = combatEvents.slice(-150).reverse().map(item => `<article><time>#${item.sequence} · R${item.round}</time><b>${escapeHtml(item.type)}</b><code>${escapeHtml(item.hash.slice(0, 12))}</code><details><summary>明细</summary><pre>${escapeHtml(JSON.stringify(item.payload, null, 2))}</pre></details></article>`).join('') || '<div class="empty-state">尚无事件</div>';
    const strategy = state?.strategy;
    $('#combatStrategyPreview').className = `strategy-preview${strategy ? '' : ' empty-state'}`;
    $('#combatStrategyPreview').innerHTML = strategy ? `<dl><dt>编译器</dt><dd>${escapeHtml(strategy.compiler || 'local-parser')}</dd><dt>优先级</dt><dd>${strategy.priorities.join(' → ')}</dd><dt>EP 保留</dt><dd>${strategy.preserveEpPercent}%</dd><dt>反应</dt><dd>${strategy.reactionPolicy}</dd></dl><h4>任一条件触发接管</h4>${strategy.takeoverTriggers.map(trigger => `<code>${trigger.field} ${trigger.operator} ${trigger.value}</code>`).join(' ')}${strategy.confirmed ? '<b class="strategy-confirmed">已确认</b>' : '<button data-action="combat-confirm-strategy">确认并启用</button>'}` : '策略会先编译为确定性规则，确认后才执行。';
    $('#combatResult').innerHTML = state?.finalResult ? `<div class="combat-result-summary"><b>${state.finalResult.winner === 'player' ? '玩家方胜利' : '敌方胜利'}</b><span>${state.finalResult.rounds} 回合 · ${state.finalResult.casualties.length} 个失能实体</span><code>${escapeHtml(state.finalResult.eventHash?.slice(0, 24) || '')}</code></div>` : state?.status === 'paused' ? `<p>正式暂停：${escapeHtml(state.pauseReason?.type || 'unknown')}</p>` : '<div class="empty-state">正式暂停或战斗结束后可生成融合剧情。</div>';
}

async function createCombatFromEditor(text) {
    const payload = JSON.parse(text);
    combatState = await combatRequest('/sessions', { method: 'POST', body: JSON.stringify(payload) });
    const session = store.activeSession; session.activeBattleId = combatState.id; session.combatIds = [...new Set([...(session.combatIds || []), combatState.id])]; store.save();
    combatEvents = (await combatRequest(`/${combatState.id}/events`)).events || [];
    await blackbox.record('combat', 'combat_created', { payload, state: combatState }, { sessionId: session.id });
    renderCombat(); toast('本地权威战斗已建立；确认编制后即可开始。', 'success');
}

async function narrateCombat() {
    if (!combatState || !['paused', 'completed'].includes(combatState.status)) return toast('只有正式暂停点或已完成战斗可生成剧情', 'error');
    const settings = store.data.settings;
    if (!settings.baseUrl || !settings.model) return toast('请先配置正文模型连接', 'error');
    const narrative = await combatRequest(`/${combatState.id}/narrative-bundle`);
    const turnId = crypto.randomUUID();
    await blackbox.record('combat', 'narration_started', { battleId: combatState.id, bundle: narrative.bundle }, { sessionId: store.activeSession?.id, turnId });
    let body = {}, prose = '', fallbackError = null;
    try {
        const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, stream: false, maxTokens: Math.max(30000, Number(settings.maxTokens) || 0), messages: [{ role: 'system', content: narrative.systemPrompt }, { role: 'user', content: narrative.userPrompt }] }) });
        body = await response.json(); if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        prose = String(body.choices?.[0]?.message?.content || '').replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '').replace(/<JSONPatch>[\s\S]*?<\/JSONPatch>/gi, '').trim();
        if (!prose) throw new Error('正文模型返回空战报');
    } catch (error) {
        fallbackError = error;
        const casualties = (narrative.bundle.casualties || []).map(item => `${item.name}（${item.state}）`).join('、') || '无';
        prose = `本地战斗演算在第 ${narrative.bundle.rounds || combatState.round} 回合抵达正式结算点。${narrative.bundle.winner ? `胜者为${narrative.bundle.winner === 'player' ? '玩家方' : '敌方'}。` : `演算因“${narrative.bundle.pauseReason?.type || '安全暂停'}”暂停。`}失能与伤亡记录：${casualties}。\n\n> 正文模型暂不可用，本楼使用本地权威战报模板；稍后可依据同一重放重新生成叙事，不会重掷。`;
        await blackbox.record('combat', 'narration_fallback_used', { battleId: combatState.id, error }, { sessionId: store.activeSession?.id, turnId });
    }
    const checks = (narrative.bundle.checkResults || []).slice(-20).map(check => `- ${check.actorId || ''} → ${check.targetId}：D100 ${check.selected} + ${check.modifier} = ${check.total} / DC ${check.defenseDC}，${check.outcome}`).join('\n');
    const patch = narrative.bundle.mvuPatch || [];
    const content = `${prose}\n\n${checks ? `<CheckResult>\n${checks}\n</CheckResult>\n\n` : ''}<UpdateVariable><JSONPatch>\n${JSON.stringify(patch, null, 2)}\n</JSONPatch></UpdateVariable>`;
    const message = store.addMessage('assistant', content); message.combat = { battleId: combatState.id, replayHash: combatState.eventHash, result: narrative.bundle }; message.tokenUsage = normalizeTokenUsage(body.usage, narrative.userPrompt, prose); store.save();
    const updated = await runtime.parseVariableUpdate(content, runtime.variables); await runtime.replaceVariables(updated);
    if (combatState.status === 'completed') await mutateCombat('finalize');
    await blackbox.record('combat', 'narration_completed', { battleId: combatState.id, messageId: message.id, tokenUsage: message.tokenUsage, prose, fallback: Boolean(fallbackError) }, { sessionId: store.activeSession?.id, turnId });
    showPanel('chat'); renderAll(); toast('权威战报已融合为剧情楼层，MVU 已按本地结果更新。', 'success');
}

function protocolLabel(value) {
    return { 'openai-chat': 'OpenAI Chat', 'openai-responses': 'OpenAI Responses', anthropic: 'Anthropic', gemini: 'Gemini' }[value] || value || 'OpenAI Chat';
}

function protocolDefaults(protocol) {
    return {
        'openai-chat': { baseUrl: 'https://api.openai.com', path: '/v1/chat/completions', modelsPath: '/v1/models' },
        'openai-responses': { baseUrl: 'https://api.openai.com', path: '/v1/responses', modelsPath: '/v1/models' },
        anthropic: { baseUrl: 'https://api.anthropic.com', path: '/v1/messages', modelsPath: '/v1/models' },
        gemini: { baseUrl: 'https://generativelanguage.googleapis.com', path: '/v1beta/models/{model}:generateContent', modelsPath: '/v1beta/models' },
    }[protocol] || { baseUrl: '', path: '/v1/chat/completions', modelsPath: '/v1/models' };
}

function renderConnectionModelOptions(filter = '') {
    const root = $('#connectionModelOptions');
    const query = String(filter).trim().toLowerCase();
    const models = connectionModelCandidates.filter(item => !query || item.toLowerCase().includes(query));
    root.innerHTML = models.slice(0, 300).map(item => `<button type="button" data-model-option="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('');
    root.classList.toggle('open', models.length > 0);
}

function renderConnectionManager() {
    const active = store.data.settings.activeConnectionId;
    $('#connectionList').innerHTML = store.data.connections.map(item => `<div class="manager-item ${item.id === active ? 'active' : ''}" data-connection-id="${item.id}"><b>${item.id === active ? '<i class="active-dot"></i>' : ''}${escapeHtml(item.name)}</b><small>${protocolLabel(item.protocol)} · ${escapeHtml(item.model || '未设置模型')}</small></div>`).join('') || '<div class="empty-state">暂无连接配置</div>';
    const current = store.data.connections.find(item => item.id === active);
    $('#activeCallSummary').innerHTML = current ? [['当前配置', current.name], ['协议', protocolLabel(current.protocol)], ['模型', current.model], ['地址', current.baseUrl]].map(([key, value]) => `<div class="active-call-row"><span>${key}</span><b>${escapeHtml(value)}</b></div>`).join('') : '<div class="empty-state">尚未选择模型连接</div>';
}

function editConnection(connection = null) {
    const form = $('#connectionForm');
    form.reset();
    const value = connection || { id: '', name: '', protocol: 'openai-chat', ...protocolDefaults('openai-chat'), apiKey: '', model: '', apiVersion: '', extraHeaders: '{}', extraBody: '{}', testPrompt: '只回复 OK', temperature: .9, maxTokens: 32768 };
    for (const [key, item] of Object.entries(value)) if (form.elements[key]) form.elements[key].value = item ?? '';
    $('#connectionEditorTitle').textContent = connection ? connection.name : '新建连接';
    $('#temperatureValue').textContent = value.temperature ?? .9;
    connectionModelCandidates = [];
    $('#connectionModelOptions').classList.remove('open');
}

function renderPresetManager() {
    $('#presetList').innerHTML = presets.map(item => `<div class="manager-item ${item.id === selectedPresetId ? 'active' : ''}" data-preset-id="${item.id}"><b>${item.id === store.data.settings.activePresetId ? '<i class="active-dot"></i>' : ''}${escapeHtml(item.name)}</b><small>${item.prompts.length} 条提示词 · ${item.prompts.filter(prompt => prompt.enabled).length} 启用</small></div>`).join('') || '<div class="empty-state">尚未导入 AIRP 预设</div>';
    const preset = presets.find(item => item.id === selectedPresetId);
    if (!preset) {
        $('#presetTitle').textContent = '未选择预设';
        $('#presetSummary').innerHTML = '导入 SillyTavern OAI JSON 预设后，可在这里查看、启停和排序提示词条目。';
        $('#promptEntries').replaceChildren();
        $('#promptEntryEditor').innerHTML = '<div class="empty-state">在左侧选择一个提示词条目</div>';
        return;
    }
    if (!preset.prompts.some(item => item.identifier === selectedPromptEntryId)) selectedPromptEntryId = preset.prompts[0]?.identifier || null;
    $('#presetTitle').textContent = preset.name;
    $('#presetSummary').innerHTML = `<div class="preset-stats"><div><small>提示词条目</small><b>${preset.prompts.length}</b></div><div><small>已启用</small><b>${preset.prompts.filter(item => item.enabled).length}</b></div><div><small>温度</small><b>${preset.sampling.temperature ?? '—'}</b></div><div><small>最大输出</small><b>${preset.sampling.maxTokens ?? '—'}</b></div></div>`;
    $('#promptEntries').innerHTML = preset.prompts.map((item, index) => `<div class="prompt-entry ${item.identifier === selectedPromptEntryId ? 'selected' : ''}" data-prompt-id="${escapeHtml(item.identifier)}"><span class="drag-handle">${index + 1}</span><div><b>${escapeHtml(item.name)}</b><small>${item.marker ? '结构标记' : `${item.role} · ${item.content.length.toLocaleString()} 字符`}</small></div><label class="icon-checkbox" title="${item.enabled ? '此条目已启用' : '此条目已停用'}"><input type="checkbox" data-prompt-toggle ${item.enabled ? 'checked' : ''}></label></div>`).join('');
    renderPromptEntryEditor(preset, preset.prompts.find(item => item.identifier === selectedPromptEntryId));
}

function renderPromptEntryEditor(preset, prompt) {
    const root = $('#promptEntryEditor');
    if (!prompt) { root.innerHTML = '<div class="empty-state">在左侧选择一个提示词条目</div>'; return; }
    root.innerHTML = `<input type="hidden" name="identifier" value="${escapeHtml(prompt.identifier)}"><header><div><small>PROMPT ENTRY</small><h3>${escapeHtml(prompt.name)}</h3></div><div><button type="button" data-action="move-prompt-up" title="上移条目">↑</button><button type="button" data-action="move-prompt-down" title="下移条目">↓</button><button type="button" data-action="delete-prompt-entry" class="danger" title="删除条目">×</button><label class="icon-checkbox" title="启用或停用此提示词"><input name="enabled" type="checkbox" ${prompt.enabled ? 'checked' : ''}></label></div></header><div class="form-grid"><label class="wide"><span>名称</span><input name="name" value="${escapeHtml(prompt.name)}"></label><label><span>角色</span><select name="role"><option value="system" ${prompt.role === 'system' ? 'selected' : ''}>system</option><option value="user" ${prompt.role === 'user' ? 'selected' : ''}>user</option><option value="assistant" ${prompt.role === 'assistant' ? 'selected' : ''}>assistant</option></select></label><label><span>注入位置</span><select name="injectionPosition"><option value="0" ${Number(prompt.injectionPosition) === 0 ? 'selected' : ''}>相对位置</option><option value="1" ${Number(prompt.injectionPosition) === 1 ? 'selected' : ''}>聊天深度</option></select></label><label><span>注入深度</span><input name="injectionDepth" type="number" min="0" value="${Number(prompt.injectionDepth ?? 4)}"></label><label class="checkbox-field" title="结构标记条目不直接发送内容"><span>Marker</span><input name="marker" type="checkbox" ${prompt.marker ? 'checked' : ''}></label><label class="wide"><span>提示词内容</span><textarea name="content" rows="18" spellcheck="false">${escapeHtml(prompt.content)}</textarea></label></div><footer><span>${prompt.content.length.toLocaleString()} 字符</span><button type="submit" class="accent-button">保存当前条目</button></footer>`;
}

function updateTextEditorStatus(message = '') {
    const input = $('#textEditorValue');
    const before = input.value.slice(0, input.selectionStart);
    const line = before.split('\n').length;
    const column = before.length - before.lastIndexOf('\n');
    const count = input.value.split('\n').length;
    $('#textEditorLines').textContent = Array.from({ length: count }, (_item, index) => index + 1).join('\n');
    $('#textEditorLines').scrollTop = input.scrollTop;
    $('#textEditorStatus').textContent = message || `${textEditorReadonly ? '只读 · ' : ''}${textEditorMode === 'json' ? 'JSON' : '文本'} · ${input.value.length.toLocaleString()} 字符 · 第 ${line} 行，第 ${column} 列`;
}

function openTextEditor({ title, value, onSave, mode = 'json', readonly = false }) {
    textEditorOriginal = value;
    textEditorSave = onSave;
    textEditorMode = mode;
    textEditorReadonly = readonly;
    textEditorSearchAt = 0;
    $('#textEditorTitle').textContent = title;
    $('#textEditorValue').value = value;
    $('#textEditorFind').value = '';
    $('#textEditorReplace').value = '';
    $('#textEditorValue').readOnly = readonly;
    $$('[data-editor-write]').forEach(item => { item.hidden = readonly; });
    $$('[data-editor-json]').forEach(item => { item.hidden = mode !== 'json'; });
    updateTextEditorStatus();
    $('#textEditorDialog').showModal();
    requestAnimationFrame(() => $('#textEditorValue').focus());
}

function findInEditor() {
    const input = $('#textEditorValue');
    const query = $('#textEditorFind').value;
    if (!query) return updateTextEditorStatus('请输入查找内容');
    let index = input.value.indexOf(query, textEditorSearchAt);
    if (index < 0) index = input.value.indexOf(query);
    if (index < 0) return updateTextEditorStatus('未找到匹配内容');
    input.focus(); input.setSelectionRange(index, index + query.length);
    textEditorSearchAt = index + query.length;
    updateTextEditorStatus();
}

async function saveTextEditor() {
    try {
        if (textEditorReadonly) { $('#textEditorDialog').close(); return; }
        const value = $('#textEditorValue').value;
        if (textEditorMode === 'json') JSON.parse(value);
        await textEditorSave?.(value);
        textEditorOriginal = value;
        $('#textEditorDialog').close();
        toast(textEditorMode === 'json' ? 'JSON 已验证并保存' : '文本已保存', 'success');
    } catch (error) {
        const position = Number(error.message.match(/position\s+(\d+)/i)?.[1]);
        if (Number.isFinite(position)) { $('#textEditorValue').focus(); $('#textEditorValue').setSelectionRange(position, position); }
        updateTextEditorStatus(`无法保存：${error.message}`);
        blackbox.record('editor', 'text_save_failed', { error, mode: textEditorMode });
    }
}

async function renderBlackBox() {
    const events = await blackbox.events();
    $('#blackboxRunId').textContent = blackbox.runId;
    $('#blackboxEventCount').textContent = events.length.toLocaleString();
    $('#blackboxSessionId').textContent = store.activeSession?.id || '—';
    $('#blackboxLastEvent').textContent = events.at(-1)?.type || '—';
    $('#blackboxState').textContent = '本机记录中';
    $('#blackboxTimeline').innerHTML = events.slice(-100).reverse().map(item => `<div class="blackbox-event"><time>${escapeHtml(new Date(item.timestamp).toLocaleTimeString())}</time><span>${escapeHtml(item.category)}</span><b>${escapeHtml(item.type)}</b></div>`).join('') || '<div class="empty-state">尚无事件</div>';
}

function scriptCapabilities(script) {
    const names = ['getChatMessages', 'setChatMessage', 'getVariables', 'updateVariablesWith', 'getWorldbook', 'generateRaw', 'eventOn'];
    return names.filter(name => script.content.includes(name));
}

function renderScriptManager() {
    $('#scriptList').innerHTML = scripts.map(item => `<div class="manager-item ${item.id === selectedScriptId ? 'active' : ''}" data-script-id="${item.id}"><b>${item.enabled ? '<i class="active-dot"></i>' : ''}${escapeHtml(item.name)}</b><small>${(item.content.length / 1024 / 1024).toFixed(1)} MB · ${item.enabled ? '已启用' : '已停用'}</small></div>`).join('') || '<div class="empty-state">尚未导入助手脚本</div>';
    const script = scripts.find(item => item.id === selectedScriptId);
    if (!script) return;
    $('#scriptTitle').textContent = script.name;
    $('#scriptSummary').innerHTML = `<div class="script-meta"><div><small>脚本体积</small><b>${(script.content.length / 1024 / 1024).toFixed(2)} MB</b></div><div><small>运行状态</small><b>${script.enabled ? '已启用' : '已停用'}</b></div></div><div class="capability-list">${scriptCapabilities(script).map(name => `<span>${name}</span>`).join('')}</div>${script.enabled ? '<button class="script-console-button" data-action="open-script-ui">打开脚本控制台</button>' : ''}`;
}

function renderRegexManager() {
    const cardScripts = runtime?.card.extensions?.regex_scripts || [];
    $('#regexPresetList').innerHTML = `<div class="manager-item ${selectedRegexPresetId === 'card' ? 'active' : ''}" data-regex-preset-id="card"><b><i class="active-dot"></i>角色卡内置正则</b><small>${cardScripts.length} 条 · 随角色卡加载</small></div>` + regexPresets.map(item => `<div class="manager-item ${item.id === selectedRegexPresetId ? 'active' : ''}" data-regex-preset-id="${item.id}"><b>${item.enabled ? '<i class="active-dot"></i>' : ''}${escapeHtml(item.name)}</b><small>${item.scripts.length} 条 · ${item.enabled ? '已启用' : '已停用'}</small></div>`).join('');
    const preset = selectedRegexPresetId === 'card' ? { name: '角色卡内置正则', enabled: true, scripts: cardScripts } : regexPresets.find(item => item.id === selectedRegexPresetId);
    if (!preset) { selectedRegexPresetId = 'card'; return renderRegexManager(); }
    $('#regexPresetTitle').textContent = preset.name;
    $('#regexPresetEnabled').checked = preset.enabled !== false;
    $('#regexPresetEnabled').disabled = selectedRegexPresetId === 'card';
    $('#regexPresetEnabled').title = selectedRegexPresetId === 'card' ? '角色卡内置正则始终启用；编辑时会自动创建副本' : (preset.enabled ? '正则预设已启用' : '正则预设已停用');
    if (!preset.scripts.some(item => item.id === selectedRegexEntryId)) selectedRegexEntryId = preset.scripts[0]?.id || null;
    $('#regexPresetSummary').innerHTML = `<div class="preset-stats"><div><small>规则数</small><b>${preset.scripts.length}</b></div><div><small>发送前</small><b>${preset.scripts.filter(item => item.promptOnly || !item.markdownOnly).length}</b></div><div><small>显示时</small><b>${preset.scripts.filter(item => !item.promptOnly).length}</b></div><div><small>状态</small><b>${preset.enabled ? '启用' : '停用'}</b></div></div>`;
    $('#regexEntries').innerHTML = preset.scripts.map((item, index) => `<div class="prompt-entry ${item.id === selectedRegexEntryId ? 'selected' : ''}" data-regex-entry-id="${escapeHtml(item.id)}"><span class="drag-handle">${index + 1}</span><div><b>${escapeHtml(item.scriptName || `正则 ${index + 1}`)}</b><small>${item.promptOnly ? 'Prompt Only' : item.markdownOnly ? 'Markdown Only' : '双管线'} · placement ${(item.placement || []).join('/')} · depth ${item.minDepth ?? '—'}~${item.maxDepth ?? '—'}</small></div><label class="icon-checkbox" title="${item.disabled ? '此正则已停用' : '此正则已启用'}"><input type="checkbox" data-regex-toggle ${item.disabled ? '' : 'checked'}></label></div>`).join('');
    renderRegexEntryEditor(preset, preset.scripts.find(item => item.id === selectedRegexEntryId));
}

function renderRegexEntryEditor(preset, rule) {
    const root = $('#regexEntryEditor');
    if (!rule) { root.innerHTML = '<div class="empty-state">在左侧选择一条正则规则</div>'; return; }
    const placement = rule.placement || [];
    root.innerHTML = `<input type="hidden" name="id" value="${escapeHtml(rule.id)}"><header><div><small>REGEX SCRIPT</small><h3>${escapeHtml(rule.scriptName)}</h3></div><div><button type="button" data-action="move-regex-up" title="上移规则">↑</button><button type="button" data-action="move-regex-down" title="下移规则">↓</button><button type="button" data-action="delete-regex-entry" class="danger" title="删除规则">×</button><label class="icon-checkbox" title="启用或停用此正则"><input name="enabled" type="checkbox" ${rule.disabled ? '' : 'checked'}></label></div></header>${selectedRegexPresetId === 'card' ? '<div class="editor-notice">编辑卡内规则时会创建一份可编辑副本，原角色卡数据保持不变。</div>' : ''}<div class="form-grid"><label class="wide"><span>脚本名称</span><input name="scriptName" value="${escapeHtml(rule.scriptName)}"></label><label class="wide"><span>查找正则</span><textarea name="findRegex" rows="5" spellcheck="false">${escapeHtml(rule.findRegex || '')}</textarea></label><label class="wide"><span>替换内容</span><textarea name="replaceString" rows="10" spellcheck="false">${escapeHtml(rule.replaceString || '')}</textarea></label><div class="checkbox-strip wide"><label title="作用于用户消息（placement 1）"><input name="placement1" type="checkbox" ${placement.includes(1) ? 'checked' : ''}></label><label title="作用于角色消息（placement 2）"><input name="placement2" type="checkbox" ${placement.includes(2) ? 'checked' : ''}></label><label title="仅用于发送模型前的 Prompt 管线"><input name="promptOnly" type="checkbox" ${rule.promptOnly ? 'checked' : ''}></label><label title="仅用于 Markdown/消息显示管线"><input name="markdownOnly" type="checkbox" ${rule.markdownOnly ? 'checked' : ''}></label><label title="编辑已有消息时重新运行"><input name="runOnEdit" type="checkbox" ${rule.runOnEdit ? 'checked' : ''}></label><label title="在查找正则中执行宏替换"><input name="substituteRegex" type="checkbox" ${Number(rule.substituteRegex) > 0 ? 'checked' : ''}></label></div><label><span>最小深度</span><input name="minDepth" type="number" min="0" value="${rule.minDepth ?? ''}"></label><label><span>最大深度</span><input name="maxDepth" type="number" min="0" value="${rule.maxDepth ?? ''}"></label><label class="wide"><span>预先移除字符串（每行一项）</span><textarea name="trimStrings" rows="3">${escapeHtml((rule.trimStrings || []).join('\n'))}</textarea></label></div><footer><span>${escapeHtml(preset.name)}</span><button type="submit" class="accent-button">保存当前规则</button></footer>`;
}

async function editableRegexPreset() {
    if (selectedRegexPresetId !== 'card') return regexPresets.find(item => item.id === selectedRegexPresetId);
    const previouslySelected = selectedRegexEntryId;
    const preset = normalizeRegexPreset({ name: '角色卡内置正则副本', enabled: true, scripts: runtime.card.extensions.regex_scripts }, '角色卡内置正则副本.json');
    await library.put('regexPresets', preset); regexPresets.push(preset); selectedRegexPresetId = preset.id;
    selectedRegexEntryId = preset.scripts.some(item => item.id === previouslySelected) ? previouslySelected : preset.scripts[0]?.id || null;
    runtime.setRegexPresets(regexPresets);
    return preset;
}

function presetByName(name) {
    if (name === 'in_use') return presets.find(item => item.id === store.data.settings.activePresetId) || null;
    return presets.find(item => item.name === name) || null;
}

function presetBridgeValue(preset) {
    if (!preset) throw new Error('预设不存在');
    const raw = preset.raw || {};
    return structuredClone({
        ...raw,
        prompts: preset.prompts,
        extensions: { ...(raw.extensions || {}), ...(preset.extensions || {}) },
        settings: {
            temperature: preset.sampling?.temperature ?? raw.temperature ?? 1,
            top_p: preset.sampling?.topP ?? raw.top_p ?? 1,
            top_k: preset.sampling?.topK ?? raw.top_k ?? 0,
            min_p: raw.min_p ?? 0,
            frequency_penalty: preset.sampling?.frequencyPenalty ?? raw.frequency_penalty ?? 0,
            presence_penalty: preset.sampling?.presencePenalty ?? raw.presence_penalty ?? 0,
            max_context: preset.sampling?.contextSize ?? raw.openai_max_context ?? 128000,
            max_completion_tokens: preset.sampling?.maxTokens ?? raw.openai_max_tokens ?? 8192,
            should_stream: raw.stream_openai !== false,
            reasoning_effort: preset.sampling?.reasoningEffort ?? raw.reasoning_effort ?? 'auto',
        },
    });
}

function rawFromPresetBridge(value) {
    const prompts = (value.prompts || []).map((prompt, index) => ({
        ...prompt,
        identifier: prompt.identifier || prompt.id || crypto.randomUUID(),
        name: prompt.name || `条目 ${index + 1}`,
        injection_position: prompt.injection_position ?? prompt.injectionPosition ?? 0,
        injection_depth: prompt.injection_depth ?? prompt.injectionDepth ?? 4,
    }));
    const settings = value.settings || {};
    const { settings: _bridgeSettings, ...source } = value;
    return {
        ...source,
        prompts,
        prompt_order: [{ character_id: 100001, order: prompts.map(prompt => ({ identifier: prompt.identifier, enabled: prompt.enabled !== false })) }],
        temperature: settings.temperature ?? value.temperature,
        top_p: settings.top_p ?? value.top_p,
        top_k: settings.top_k ?? value.top_k,
        min_p: settings.min_p ?? value.min_p,
        frequency_penalty: settings.frequency_penalty ?? value.frequency_penalty,
        presence_penalty: settings.presence_penalty ?? value.presence_penalty,
        openai_max_context: settings.max_context ?? value.openai_max_context,
        openai_max_tokens: settings.max_completion_tokens ?? value.openai_max_tokens,
        stream_openai: settings.should_stream ?? value.stream_openai,
        reasoning_effort: settings.reasoning_effort ?? value.reasoning_effort,
        extensions: value.extensions || {},
    };
}

async function saveBridgePreset(name, value, existing = presetByName(name)) {
    const normalized = normalizePreset(rawFromPresetBridge(value), `${name}.json`);
    if (existing) normalized.id = existing.id;
    normalized.name = name;
    await library.put('presets', normalized);
    presets = presets.filter(item => item.id !== normalized.id && item.name !== name).concat(normalized);
    if (existing?.id === store.data.settings.activePresetId || name === 'in_use') {
        store.updateSettings({ activePresetId: normalized.id }); runtime.setPreset(normalized);
    }
    selectedPresetId = normalized.id; renderPresetManager();
    return normalized;
}

function installPresetBridge() {
    const api = {
        getPresetNames: () => presets.map(item => item.name),
        getLoadedPresetName: () => presetByName('in_use')?.name || '',
        getPreset: name => presetBridgeValue(presetByName(name)),
        isPresetNormalPrompt: prompt => !prompt?.marker,
        isPresetSystemPrompt: prompt => Boolean(prompt?.marker || prompt?.role === 'system'),
        importRawPreset: async (name, content) => {
            try {
                const raw = typeof content === 'string' ? JSON.parse(content) : content;
                await saveBridgePreset(String(name).replace(/\.json$/i, ''), raw);
                return true;
            } catch (error) { console.error('[preset bridge] importRawPreset', error); return false; }
        },
        loadPreset: name => {
            const preset = presetByName(name); if (!preset) return false;
            store.updateSettings({ activePresetId: preset.id }); runtime.setPreset(preset); selectedPresetId = preset.id; renderPresetManager(); return true;
        },
        replacePreset: async (name, value) => { await saveBridgePreset(name === 'in_use' ? presetByName('in_use')?.name : name, value, presetByName(name)); return true; },
        updatePresetWith: async (name, callback) => {
            const preset = presetByName(name); if (!preset) return false;
            const value = presetBridgeValue(preset); const result = await callback(value);
            await saveBridgePreset(preset.name, result ?? value, preset); return true;
        },
        createPreset: async (name, value = { prompts: [], extensions: {} }) => { await saveBridgePreset(name, value); return true; },
        deletePreset: async name => {
            const preset = presetByName(name); if (!preset) return false;
            await library.delete('presets', preset.id); presets = presets.filter(item => item.id !== preset.id);
            if (store.data.settings.activePresetId === preset.id) { store.updateSettings({ activePresetId: null }); runtime.setPreset(null); }
            selectedPresetId = presets[0]?.id || null; renderPresetManager(); return true;
        },
        renamePreset: async (oldName, newName) => {
            const preset = presetByName(oldName); if (!preset || !newName) return false;
            preset.name = newName; await library.put('presets', preset); renderPresetManager(); return true;
        },
        exportPreset: name => {
            const preset = presetByName(name); if (!preset) return false;
            const blob = new Blob([JSON.stringify(rawFromPresetBridge(presetBridgeValue(preset)), null, 2)], { type: 'application/json' });
            const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${preset.name}.json`; link.click(); URL.revokeObjectURL(link.href); return true;
        },
        forgeShop: forgePersonalShop,
        forge_shop: forgePersonalShop,
    };
    Object.assign(window, api);
    Object.assign(window.TavernHelper, api);
}

async function loadLibraries() {
    [presets, scripts, profiles, regexPresets] = await Promise.all([library.list('presets'), library.list('scripts'), library.list('profiles'), library.list('regexPresets')]);
    selectedPresetId = store.data.settings.activePresetId || presets[0]?.id || null;
    selectedScriptId = scripts[0]?.id || null;
    const active = presets.find(item => item.id === store.data.settings.activePresetId) || null;
    runtime.setPreset(active);
    runtime.setRegexPresets(regexPresets);
    installPresetBridge();
    renderPresetManager(); renderScriptManager(); renderRegexManager(); renderConnectionManager();
    for (const script of scripts.filter(item => item.enabled)) executeAssistantScript(script).catch(error => toast(`${script.name} 启动失败：${error.message}`, 'error'));
}

async function importPresetFile(file) {
    const preset = normalizePreset(JSON.parse(await file.text()), file.name);
    await library.put('presets', preset);
    presets = presets.filter(item => item.id !== preset.id).concat(preset); selectedPresetId = preset.id;
    renderPresetManager(); toast(`已导入 AIRP 预设：${preset.name}`, 'success');
}

async function importScriptFile(file) {
    const text = await file.text();
    let raw;
    try { raw = JSON.parse(text); }
    catch (error) {
        if (!/\.m?js$/i.test(file.name)) throw new Error(`JSON 解析失败：${error.message}`);
        raw = { type: 'script', name: file.name.replace(/\.m?js$/i, ''), content: text, enabled: true };
    }
    const script = normalizeScript(raw, file.name);
    await library.put('scripts', script);
    scripts = scripts.filter(item => item.id !== script.id).concat(script); selectedScriptId = script.id;
    renderScriptManager();
    if (script.enabled) executeAssistantScript(script).catch(error => toast(`${script.name} 启动失败：${error.message}`, 'error'));
    toast(`已导入助手脚本：${script.name}`, 'success');
}

async function importScriptUrl(sourceUrl) {
    let remote;
    const response = await fetch('/api/import-script-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sourceUrl }) });
    const responseText = await response.text();
    try { remote = JSON.parse(responseText); }
    catch {
        if (/^\s*<!doctype|^\s*<html/i.test(responseText)) {
            try {
                const direct = await fetch(sourceUrl);
                if (!direct.ok) throw new Error(`${direct.status} ${direct.statusText}`);
                const url = new URL(sourceUrl);
                const parts = url.pathname.split('/').filter(Boolean).map(item => decodeURIComponent(item));
                const leaf = parts.at(-1) || '远程助手脚本.js';
                const filename = /^index\.(?:m?js|json)$/i.test(leaf) && parts.length > 1 ? `${parts.at(-2)}${leaf.slice(5)}` : leaf;
                remote = { url: direct.url || sourceUrl, filename, contentType: direct.headers.get('content-type') || '', content: await direct.text() };
            } catch (error) {
                throw new Error(`本机仍在运行旧版服务，且 CDN 直连失败（${error.message}）。请关闭旧窗口并重新启动网页版。`);
            }
        } else throw new Error(`本机导入接口返回了无法识别的内容（HTTP ${response.status}）`);
    }
    if (!response.ok && !remote?.content) throw new Error(remote?.error || response.statusText);
    let raw;
    try { raw = JSON.parse(remote.content); }
    catch (error) {
        if (!/\.(?:m?js)(?:$|\?)/i.test(remote.filename) && !/javascript|ecmascript/i.test(remote.contentType)) throw new Error(`远程 JSON 解析失败：${error.message}`);
        raw = { type: 'script', name: remote.filename.replace(/\.m?js$/i, ''), content: remote.content, enabled: true };
    }
    const script = { ...normalizeScript(raw, remote.filename), sourceUrl: remote.url };
    await library.put('scripts', script);
    scripts = scripts.filter(item => item.id !== script.id).concat(script); selectedScriptId = script.id;
    renderScriptManager();
    if (script.enabled) executeAssistantScript(script).catch(error => toast(`${script.name} 启动失败：${error.message}`, 'error'));
    toast(`已从 URL 导入：${script.name}`, 'success');
}

async function callExtraModel(messages, options = {}) {
    const settings = { ...store.data.settings, ...options };
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, messages: typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || JSON.stringify(data));
    return data.choices?.[0]?.message?.content || '';
}

async function executeAssistantScript(script) {
    if (scriptFrames.has(script.id) || !script.enabled) return;
    await blackbox.record('script', 'script_starting', { id: script.id, name: script.name, sourceUrl: script.sourceUrl, size: script.content.length }, { sessionId: store.activeSession?.id });
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.dataset.assistantScript = script.id;
    document.body.append(frame);
    const win = frame.contentWindow;
    frame.contentDocument.addEventListener('focusin', event => {
        if (!frame.hidden) return;
        event.target?.blur?.();
        window.focus();
    }, true);
    win.$ = win.jQuery = jquery;
    const saveData = async data => { script.data = data; await library.put('scripts', script); };
    Object.assign(win, {
        $: jquery, jQuery: jquery, _: window._, z: Zod, Vue, toastr: window.toastr, TavernHelper: window.TavernHelper,
        SillyTavern: { ...window.SillyTavern, getCurrentChatId: () => store.activeSession?.id || '', getCurrentMessageId: () => activeMessageId },
        tavern_events: window.tavern_events, chat_metadata: window.chat_metadata, chat: store.activeSession?.messages || [],
        getChatMessages: window.getChatMessages, setChatMessage: window.setChatMessage, setChatMessages: window.setChatMessages,
        getCurrentChatId: () => store.activeSession?.id || '', getCurrentMessageId: () => activeMessageId,
        getScriptId: () => script.id, getScriptName: () => script.name,
        getVariables: options => options?.type === 'script' ? structuredClone(script.data || {}) : window.getVariables(options),
        replaceVariables: async (data, options) => options?.type === 'script' ? saveData(structuredClone(data)) : runtime.replaceVariables(data),
        updateVariablesWith: async (callback, options) => { if (options?.type === 'script') { const data = structuredClone(script.data || {}); await saveData(await callback(data) ?? data); } else return window.updateVariablesWith(callback); },
        getWorldbookNames: () => [runtime.card.extensions?.world || runtime.card.name],
        getCharWorldbookNames: () => [runtime.card.extensions?.world || runtime.card.name],
        getChatWorldbookName: () => runtime.card.extensions?.world || runtime.card.name,
        getGlobalWorldbookNames: () => [],
        getWorldbook: () => structuredClone(runtime.card.character_book?.entries || []),
        injectPrompts: window.injectPrompts,
        getPresetNames: window.getPresetNames, getLoadedPresetName: window.getLoadedPresetName, getPreset: window.getPreset,
        isPresetNormalPrompt: window.isPresetNormalPrompt, isPresetSystemPrompt: window.isPresetSystemPrompt,
        importRawPreset: window.importRawPreset, loadPreset: window.loadPreset, replacePreset: window.replacePreset,
        updatePresetWith: window.updatePresetWith, createPreset: window.createPreset, deletePreset: window.deletePreset,
        renamePreset: window.renamePreset, exportPreset: window.exportPreset,
        generate: options => callExtraModel(options?.prompt || options?.messages || options, options || {}),
        generateRaw: options => callExtraModel(options?.prompt || options?.messages || options, options || {}),
        forgeShop: forgePersonalShop,
        forge_shop: forgePersonalShop,
        eventOn: window.eventOn, eventEmit: window.eventEmit, waitGlobalInitialized: window.waitGlobalInitialized,
        getUserName: () => store.data.settings.userName, getCharName: () => runtime.card.name,
    });
    const blob = new Blob([script.content], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const tag = frame.contentDocument.createElement('script');
    tag.type = 'module'; tag.src = url;
    const loaded = new Promise((resolve, reject) => { tag.onload = resolve; tag.onerror = () => reject(new Error('模块加载失败')); });
    frame.contentDocument.head.append(tag);
    scriptFrames.set(script.id, { frame, url });
    try { await loaded; await blackbox.record('script', 'script_started', { id: script.id, name: script.name }, { sessionId: store.activeSession?.id }); }
    catch (error) { await blackbox.record('script', 'script_failed', { id: script.id, name: script.name, error }, { sessionId: store.activeSession?.id }); throw error; }
}

function openAssistantScriptUi(id) {
    const running = scriptFrames.get(id);
    if (!running) return toast('脚本仍在启动或启动失败', 'error');
    const selector = '.zhino-fab,.chaoxi-fab,[class*="floating"] button,[class*="fab"]';
    const scriptRoots = [...document.querySelectorAll(`[script_id="${CSS.escape(id)}"]`)];
    const trigger = scriptRoots.map(root => root.matches(selector) ? root : root.querySelector(selector)).find(Boolean);
    if (trigger) {
        const rect = trigger.getBoundingClientRect();
        const init = { bubbles: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, screenX: rect.left + rect.width / 2, screenY: rect.top + rect.height / 2 };
        trigger.dispatchEvent(new PointerEvent('pointerdown', init));
        window.dispatchEvent(new PointerEvent('pointerup', init));
        trigger.click();
    } else toast('脚本已在宿主页面运行；请使用它自己的悬浮球打开界面', 'info');
}

function stopAssistantScript(id) {
    const running = scriptFrames.get(id);
    if (!running) return;
    document.querySelectorAll(`[script_id="${CSS.escape(id)}"]`).forEach(node => node.remove());
    running.frame.remove(); URL.revokeObjectURL(running.url); scriptFrames.delete(id);
}

function renderIntegrity(result) {
    const data = runtime.card;
    const rows = [
        ['角色卡协议', `${runtime.envelope.spec} ${runtime.envelope.spec_version}`, true],
        ['世界书', `${data.character_book?.entries?.length ?? 0} / 41`, data.character_book?.entries?.length === 41],
        ['正则脚本', `${data.extensions?.regex_scripts?.length ?? 0} / 12`, data.extensions?.regex_scripts?.length === 12],
        ['玩法脚本', `${result.loaded.length + result.failed.length} / 4`, result.loaded.length + result.failed.length === 4],
        ...result.loaded.map(item => [item.name, item.mode, true]),
        ...result.failed.map(item => [item.name, `远程模块暂不可用：${item.error}`, false]),
    ];
    $('#integrityDetails').innerHTML = rows.map(([name, value, ok]) => `<div class="integrity-row"><span>${escapeHtml(name)}</span><b class="${ok ? 'ok' : ''}">${escapeHtml(value)}</b></div>`).join('');
}

function fillSettings() {
    const form = $('#settingsForm');
    for (const [key, value] of Object.entries(store.data.settings)) if (form.elements[key]) form.elements[key].value = value;
    const active = store.data.connections.find(item => item.id === store.data.settings.activeConnectionId) || null;
    editConnection(active);
    renderConnectionManager();
    applyUiScale();
}

function applyUiScale() {
    const scale = Math.min(1.5, Math.max(.85, Number(store.data.settings.uiScale) || 1));
    document.documentElement.style.setProperty('--ui-scale', String(scale));
}

function renderAll() {
    renderMessages();
    renderStatus();
    renderMissions();
    renderInventory();
    renderAbilities();
    renderWorld();
    renderRelations();
    renderPersonalShop();
    renderIntel();
    renderHudAndHub();
    renderArchive();
    renderConnectionManager();
    renderCombat();
}

function showPanel(panel) {
    $$('.view').forEach(item => item.classList.toggle('active', item.id === `view-${panel}`));
    $$('.nav-item[data-panel]').forEach(item => item.classList.toggle('active', item.dataset.panel === panel));
    const labels = { hub: '世界总览', chat: '剧情楼层', combat: '战术演算', status: '主角档案', shop: '个人商店终端', inventory: '装备与道具', abilities: '技能与血统', missions: '任务', world: '世界档案', relations: '实体关系', intel: '情报与传闻', archive: '存档管理', settings: '系统设置' };
    $('#routeLabel').textContent = labels[panel] ?? panel;
    $('#rail').classList.remove('open');
    if (panel === 'combat') loadCombat({ quiet: true });
}

async function newSession() {
    const variables = runtime.createInitialVariables();
    const session = store.createSession({ firstMessage: runtime.card.first_mes || '【封面】', variables });
    const first = session.messages[0];
    if (first) first.swipes = [runtime.card.first_mes, ...(runtime.card.alternate_greetings ?? [])];
    store.save();
    loadPersonalShopState();
    combatState = null; combatEvents = []; pendingCombatScriptReview = null;
    await runtime.emit(window.Mvu.events.VARIABLE_INITIALIZED, runtime.variables, 0);
    await blackbox.record('session', 'session_created', { title: session.title, firstMessage: session.messages[0]?.content, variables: session.variables }, { sessionId: session.id });
    showPanel('hub');
    renderAll();
}

const attributeKeys = ['力量', '敏捷', '体质', '精神', '魅力'];
let setupStep = 0;
let attributePoints = Object.fromEntries(attributeKeys.map(key => [key, 0]));
const qualityLevels = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];

function renderAttributeBuilder() {
    $('#attributeBuilder').innerHTML = attributeKeys.map(key => `<div class="attribute-item"><span>${key}</span><b>${qualityLevels[attributePoints[key]]}</b><div><button type="button" data-attribute="${key}" data-delta="-1">−</button><button type="button" data-attribute="${key}" data-delta="1">＋</button></div></div>`).join('');
    $('#pointsLeft').textContent = 8 - Object.values(attributePoints).reduce((sum, value) => sum + value, 0);
}

function starterItems() {
    if (!openingData) return [];
    return [
        ...(openingData.equipments || []).map(item => ({ ...item, _cat: 'equipment' })),
        ...(openingData.items || []).map(item => ({ ...item, _cat: 'item' })),
        ...(openingData.skills || []).map(item => ({ ...item, _cat: 'skill' })),
        ...customStarterItems,
    ];
}

function personalCatalogItems() {
    const catalog = store.activeSession?.personalShop?.catalog;
    if (!catalog) return [];
    const mapping = [['血统列表', 'bloodline'], ['技能列表', 'skill'], ['装备列表', 'equipment'], ['道具列表', 'item'], ['升级列表', 'upgrade']];
    return mapping.flatMap(([key, category]) => (Array.isArray(catalog[key]) ? catalog[key] : []).map((entry, index) => ({
        ...entry,
        id: `shop:${category}:${entry.id || index + 1}`,
        name: entry.名称 || entry.name || '未命名商品',
        tier: entry.品质 || entry.tier || 'F',
        cost: Number(entry.价格 ?? entry.cost ?? 0),
        desc: entry.描述 || entry.desc || '',
        tags: entry.标签 || entry.tags || [],
        attrs: entry.原始属性 || entry.被动属性 || entry.attrs || Object.fromEntries(['命中', '伤害', 'DEF', 'MDEF'].filter(key => entry[key] !== undefined).map(key => [key, entry[key]])),
        effects: entry.效果 || entry.特效 || entry.特殊效果 || entry.effects || {},
        consume: entry.消耗 || entry.consume || '',
        _cat: category,
        _shopGenerated: true,
        _catalogEntry: entry,
    })));
}

function personalShopItems() {
    const generated = personalCatalogItems();
    if (!generated.length) return starterItems();
    // 首次刷新后以个人目录为准；此前已选的开局兑换仍保留在购物车，避免刷新造成购买状态丢失。
    return [...generated, ...starterItems().filter(item => selectedStarterIds.has(item.id))];
}

function loadPersonalShopState() {
    const state = store.activeSession?.personalShop || { selectedIds: [], customItems: [], catalog: null, history: [], lastRefresh: null };
    selectedStarterIds = new Set(state.selectedIds || []);
    customStarterItems = structuredClone(state.customItems || []);
    personalShopExtraRequirement = String(state.extraRequirement || '');
}

function persistPersonalShopState() {
    const session = store.activeSession; if (!session) return;
    const state = session.personalShop || {};
    session.personalShop = { ...state, selectedIds: [...selectedStarterIds], customItems: structuredClone(customStarterItems), history: structuredClone(state.history || []), updatedAt: new Date().toISOString() };
    store.save();
}

function partnerCost() {
    const form = $('#setupForm');
    return form.elements.partnerEnabled.checked ? ({ Ⅰ: 70, Ⅱ: 350, Ⅲ: 1000 }[form.elements.partnerTier.value] || 0) : 0;
}

function setupBalance() {
    return shopBalance() - partnerCost();
}

function shopBalance() {
    const selectedCost = starterItems().filter(item => selectedStarterIds.has(item.id)).reduce((sum, item) => sum + Number(item.cost || 0), 0);
    return Number(openingData?.initSpaceCoins || 1000) - selectedCost;
}

function personalShopBalance() {
    const selectedCost = personalShopItems().filter(item => selectedStarterIds.has(item.id)).reduce((sum, item) => sum + Number(item.cost || 0), 0);
    return Number(openingData?.initSpaceCoins || 1000) - selectedCost;
}

function shopItemCard(item, { personal = false } = {}) {
    const selected = selectedStarterIds.has(item.id); const disabled = !selected && Number(item.cost || 0) > (personal ? personalShopBalance() : shopBalance());
    const properties = [item.consume && ['消耗', item.consume], item.attrs && Object.keys(item.attrs).length && ['属性', Object.entries(item.attrs).map(([key, value]) => `${key}+${value}`).join(' · ')], item.effects && Object.keys(item.effects).length && ['效果', Object.entries(item.effects).map(([key, value]) => `${key}:${plainValue(value)}`).join(' · ')]].filter(Boolean);
    return `<button type="button" class="setup-shop-item item-card t-${escapeHtml(item.tier)} ${selected ? 'selected is-selected' : ''} ${disabled ? 'is-disabled' : ''}" data-starter-id="${escapeHtml(item.id)}" ${disabled ? 'disabled' : ''}><span class="selected-corner">已选择</span><header class="card-header"><h4 class="item-name">${escapeHtml(item.name)}</h4><span class="item-rarity">${escapeHtml(item.tier)}</span></header><div class="card-body"><p>${escapeHtml(item.desc || '暂无描述')}</p>${properties.map(([label, value]) => `<div class="item-info"><b>${label}</b><span>${escapeHtml(value)}</span></div>`).join('')}<div class="tag-list">${(item.tags || []).slice(0, 6).map(tag => `<i>${escapeHtml(tag)}</i>`).join('')}</div></div><footer><span>${escapeHtml({ equipment: '装备', item: '道具', skill: '技能', bloodline: '血统', upgrade: '升级' }[item._cat] || item._cat || '兑换')}</span><b>¤ ${Number(item.cost).toLocaleString()}</b></footer></button>`;
}

function renderSetupShop() {
    if (!openingData) { $('#setupShopItems').innerHTML = '<div class="empty-state">开局数据库加载中…</div>'; return; }
    const query = $('#setupShopSearch').value.trim().toLowerCase();
    const category = setupShopCategory;
    const rarity = setupShopRarity;
    const items = starterItems().filter(item => (category === 'all' || item._cat === category) && (rarity === 'all' || item.tier === rarity) && (!query || [item.name, item.desc, ...(item.tags || [])].join(' ').toLowerCase().includes(query)));
    $('#setupShopItems').innerHTML = items.map(item => shopItemCard(item)).join('') || '<div class="empty-state">没有匹配的兑换项</div>';
    const chosen = starterItems().filter(item => selectedStarterIds.has(item.id));
    $('#setupCoins').textContent = setupBalance().toLocaleString();
    $('#setupCoins').classList.toggle('negative', setupBalance() < 0);
    $('#setupCart').innerHTML = `<div><b>已选兑换 <i>${chosen.length}</i></b><small>总计消耗 ${(Number(openingData?.initSpaceCoins || 1000) - shopBalance()).toLocaleString()} 空间币</small></div><div class="setup-cart-chips">${chosen.map(item => `<button type="button" data-starter-id="${escapeHtml(item.id)}">${escapeHtml(item.name)} <b>×</b></button>`).join('') || '<span>尚未选择兑换项</span>'}</div>`;
    renderPartnerState();
}

function renderPersonalShop() {
    const root = $('#personalShopContent'); if (!root) return;
    if (!openingData) { root.innerHTML = '<div class="empty-state">个人商城数据库加载中…</div>'; return; }
    const items = personalShopItems().filter(item => (personalShopCategory === 'all' || item._cat === personalShopCategory) && (personalShopRarity === 'all' || item.tier === personalShopRarity) && (!personalShopSearch || [item.name, item.desc, ...(item.tags || [])].join(' ').toLowerCase().includes(personalShopSearch)));
    const chosen = personalShopItems().filter(item => selectedStarterIds.has(item.id));
    const state = store.activeSession?.personalShop || {};
    const last = state.lastRefresh;
    const hero = runtime.variables.stat_data?.主角 || {};
    const level = heroLifeLevel(hero);
    const activeConnection = store.data.connections.find(item => item.id === store.data.settings.activeConnectionId) || store.data.settings;
    const elapsed = personalShopRefreshBusy ? `${Math.max(0, (Date.now() - personalShopRefreshStartedAt) / 1000).toFixed(1)} 秒` : '';
    const status = personalShopRefreshBusy ? `${personalShopRefreshStatus || '正在等待模型响应'} · 已用时 ${elapsed} · 再点一次取消` : (last ? `上次完成：${escapeHtml(last.source || 'local')} · ${escapeHtml(formatTime(last.generatedAt || last.at || Date.now()))} · 用时 ${last.elapsedMs ? `${(last.elapsedMs / 1000).toFixed(1)} 秒` : '—'} · seed ${escapeHtml(last.seed || '—')}` : '尚未刷新；目标、槽位和数量由当前大模型自行决定');
    root.innerHTML = `<section class="personal-shop-wallet"><div><small>PERSONAL WALLET</small><b>¤ ${personalShopBalance().toLocaleString()}</b></div><span>${escapeHtml(hero.姓名 || store.data.settings.userName || '当前人物')} · 独立终端</span></section><section class="personal-shop-refresh"><header><div><small>AI SHOP TERMINAL · forge_shop</small><b>大模型自主决定本次商品目标</b></div><span>${escapeHtml(activeConnection?.model || '未选择 API')}</span></header><div class="shop-refresh-grid shop-refresh-readonly"><div><small>生命层级 · MVU</small><b>${escapeHtml(`生命层级 · ${lifeLevelRoman(level)}`)}</b><em>读取 stat_data.主角.层级</em></div><label class="wide">额外要求（可选）<input id="personalShopQuery" value="${escapeHtml(personalShopExtraRequirement)}" placeholder="例如：偏向火焰、适合近战、避免重复商品"></label></div><button type="button" class="ai-refresh-button ${personalShopRefreshBusy ? 'is-busy' : ''}" data-action="refresh-personal-shop"><span class="ai-refresh-icon">✦</span><span><b>${personalShopRefreshBusy ? '取消本次商城刷新' : '让大模型生成个人商城'}</b><small>${personalShopRefreshBusy ? '再次点击立即取消 · 不写入半成品' : '模型将结合生命层级、库存和额外要求自主选择目标'}</small></span><i>${personalShopRefreshBusy ? 'CANCEL' : 'GENERATE'}</i></button><small class="shop-refresh-status ${personalShopRefreshBusy ? 'is-running' : ''}">${status}</small></section><section class="personal-shop-layout"><aside><input data-personal-shop-search value="${escapeHtml(personalShopSearch)}" placeholder="搜索兑换项"><div>${[['all','全部分类'],['equipment','装备'],['item','道具'],['skill','技能'],['bloodline','血统'],['upgrade','升级']].map(([key,label]) => `<button data-personal-shop-category="${key}" class="${personalShopCategory === key ? 'active' : ''}">${label}</button>`).join('')}</div></aside><main><div class="personal-rarity-filter">${['all','F','E','D','C','B','A','S','SS','SSS'].map(key => `<button data-personal-shop-rarity="${key}" class="${personalShopRarity === key ? 'active' : ''}">${key === 'all' ? '全部品质' : key}</button>`).join('')}</div><div class="setup-shop-grid">${items.map(item => shopItemCard(item, { personal: true })).join('') || '<div class="empty-state">没有匹配的兑换项</div>'}</div></main></section><section class="selected-panel personal-shop-cart"><header><div><b>当前人物购物车</b><small>选择状态随人物存档持久化</small></div><span>${chosen.length}</span></header><div>${chosen.map(item => `<button data-starter-id="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ¤${item.cost} ×</button>`).join('') || '<p>尚未选择兑换项</p>'}</div></section>`;
}

async function refreshPersonalShop() {
    const session = store.activeSession;
    if (!session) return;
    if (personalShopRefreshBusy) {
        personalShopRefreshAbort?.abort(new DOMException('用户取消商城刷新', 'AbortError'));
        personalShopRefreshStatus = '正在取消请求';
        renderPersonalShop();
        return;
    }
    const query = String($('#personalShopQuery')?.value || personalShopExtraRequirement || '').trim().slice(0, 500);
    personalShopExtraRequirement = query;
    personalShopRefreshBusy = true;
    personalShopRefreshStartedAt = Date.now();
    personalShopRefreshStatus = '正在请求大模型决定刷新目标';
    personalShopRefreshAbort = new AbortController();
    clearInterval(personalShopRefreshTimer);
    personalShopRefreshTimer = setInterval(() => { if (personalShopRefreshBusy) renderPersonalShop(); }, 500);
    renderPersonalShop();
    const hero = runtime.variables.stat_data?.主角 || {};
    const playerLevel = heroLifeLevel(hero);
    const connection = store.data.connections.find(item => item.id === store.data.settings.activeConnectionId) || store.data.settings;
    const preset = runtime.activePreset ? { name: runtime.activePreset.name, prompts: (runtime.activePreset.prompts || []).filter(item => item.enabled !== false).map(item => ({ role: item.role, content: runtime.renderTemplate(item.content) })) } : null;
    const payload = { characterName: hero.姓名 || store.data.settings.userName || '轮回者', playerLevel, playerLifeLevel: lifeLevelRoman(playerLevel), target: { autonomous: true, categories: ['all'], query }, seed: crypto.randomUUID(), hero, currentCatalog: session.personalShop?.catalog || {}, connection, preset };
    const connectionMeta = { id: connection.id, name: connection.name, model: connection.model, protocol: connection.protocol };
    await blackbox.record('shop', 'shop_refresh_started', { target: 'model-decided', extraRequirement: query, playerLevel, connection: connectionMeta }, { sessionId: session.id });
    try {
        const response = await fetch('/api/shop/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: personalShopRefreshAbort.signal });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error || `刷新失败（${response.status}）`);
        personalShopRefreshStatus = '已收到模型结果，正在写入独立终端';
        const elapsedMs = Date.now() - personalShopRefreshStartedAt;
        session.personalShop = { ...(session.personalShop || {}), extraRequirement: query, catalog: body.catalog, lastRefresh: { refreshId: body.refreshId, source: body.source, seed: body.seed, generatedAt: body.generatedAt, target: body.target, playerLevel: body.playerLevel, elapsedMs }, history: [...(session.personalShop?.history || []), { refreshId: body.refreshId, source: body.source, seed: body.seed, generatedAt: body.generatedAt, target: body.target, playerLevel: body.playerLevel, elapsedMs }].slice(-30) };
        store.save();
        await blackbox.record('shop', 'shop_refresh_completed', { refreshId: body.refreshId, source: body.source, warnings: body.warnings, apiTrace: body.apiTrace, catalogCounts: Object.fromEntries(Object.entries(body.catalog || {}).filter(([key]) => key.endsWith('列表')).map(([key, list]) => [key, list.length])) }, { sessionId: session.id });
        toast(body.source === 'api' ? '大模型已完成个人商城刷新' : '已使用本地规则完成商城兜底刷新', body.source === 'api' ? 'success' : 'info');
        if (body.warnings?.length) toast(body.warnings[0], 'info');
    } catch (error) {
        if (error.name === 'AbortError') {
            await blackbox.record('shop', 'shop_refresh_cancelled', { target: 'model-decided', elapsedMs: Date.now() - personalShopRefreshStartedAt }, { sessionId: session.id });
            toast('已取消商城刷新，未写入半成品', 'info');
        } else {
            await blackbox.record('shop', 'shop_refresh_failed', { error: error.message, target: payload.target, connection: connectionMeta }, { sessionId: session.id });
            toast(`商城刷新失败：${error.message}`, 'error');
        }
    } finally {
        personalShopRefreshBusy = false;
        personalShopRefreshAbort = null;
        clearInterval(personalShopRefreshTimer);
        personalShopRefreshTimer = null;
        personalShopRefreshStatus = '';
        renderPersonalShop();
    }
}

// 酒馆助手/卡内脚本可直接调用的 forge_shop 兼容入口。它不依赖页面焦点，结果仍只写入当前人物的独立商店存档。
async function forgePersonalShop(args = {}) {
    const session = store.activeSession;
    if (!session) throw new Error('当前没有活动存档');
    const hero = runtime.variables.stat_data?.主角 || {};
    const connection = store.data.connections.find(item => item.id === store.data.settings.activeConnectionId) || store.data.settings;
    const playerLevel = heroLifeLevel(hero);
    const payload = {
        characterName: hero.姓名 || store.data.settings.userName || '轮回者', playerLevel, playerLifeLevel: lifeLevelRoman(playerLevel),
        target: { autonomous: true, categories: ['all'], query: String(args.要求 ?? args.query ?? '').slice(0, 500) },
        seed: args.seed || crypto.randomUUID(), hero, currentCatalog: session.personalShop?.catalog || {}, connection,
        preset: runtime.activePreset ? { name: runtime.activePreset.name, prompts: (runtime.activePreset.prompts || []).filter(item => item.enabled !== false).map(item => ({ role: item.role, content: runtime.renderTemplate(item.content) })) } : null,
    };
    const response = await fetch('/api/shop/forge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `forge_shop 失败（${response.status}）`);
    session.personalShop = { ...(session.personalShop || {}), catalog: body.catalog, lastRefresh: { refreshId: body.refreshId, source: body.source, seed: body.seed, generatedAt: body.generatedAt, target: body.target, playerLevel: body.playerLevel }, history: [...(session.personalShop?.history || []), { refreshId: body.refreshId, source: body.source, seed: body.seed, generatedAt: body.generatedAt, target: body.target, playerLevel: body.playerLevel }].slice(-30) };
    store.save();
    renderPersonalShop();
    await blackbox.record('shop', 'shop_forge_called', { refreshId: body.refreshId, source: body.source, target: body.target, playerLevel: body.playerLevel, apiTrace: body.apiTrace }, { sessionId: session.id });
    return body;
}

function renderSetupPlots() {
    if (!openingData) return;
    $('#setupPlots').innerHTML = (openingData.plots || []).map(plot => `<button type="button" class="setup-plot ${selectedPlotId === plot.id ? 'selected' : ''}" data-plot-id="${escapeHtml(plot.id)}"><b>${escapeHtml(plot.name)}</b><span>位格 ${escapeHtml(plot.rank || 'Ⅰ')} · 难度 ${escapeHtml(plot.tier || 'F~E')}</span><small>${escapeHtml(plot.time || '')}</small></button>`).join('');
}

function renderPartnerState() {
    const form = $('#setupForm'); if (!form) return;
    const enabled = form.elements.partnerEnabled.checked;
    const cost = partnerCost(); const balance = setupBalance();
    $('#partnerCostState').textContent = enabled ? `消耗 ${cost} · 余额 ${balance}` : '未创建';
    $$('[name^="partner"]', form).filter(input => input.name !== 'partnerEnabled').forEach(input => { input.disabled = !enabled; });
}

function collectProfileState() {
    const form = $('#setupForm'); const values = Object.fromEntries(new FormData(form));
    return { version: 1, values, attributes: structuredClone(attributePoints), starterIds: [...selectedStarterIds], customStarterItems: structuredClone(customStarterItems), selectedPlotId, savedAt: new Date().toISOString() };
}

function applyProfileState(state) {
    const form = $('#setupForm');
    for (const [key, value] of Object.entries(state.values || {})) {
        const field = form.elements[key]; if (!field) continue;
        if (field instanceof RadioNodeList) { const target = [...field].find(item => item.value === value); if (target) target.checked = true; }
        else if (field.type === 'checkbox') field.checked = value === 'on' || value === true;
        else field.value = value ?? '';
    }
    attributePoints = Object.fromEntries(attributeKeys.map(key => [key, Number(state.attributes?.[key] || 0)]));
    customStarterItems = structuredClone(state.customStarterItems || []);
    selectedStarterIds = new Set((state.starterIds || []).filter(id => starterItems().some(item => item.id === id)));
    selectedPlotId = state.selectedPlotId || null;
    persistPersonalShopState();
    renderAttributeBuilder(); renderSetupShop(); renderSetupPlots(); renderPartnerState(); renderSetupSummary();
}

function renderProfiles() {
    $('#profileList').innerHTML = profiles.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(profile => `<div class="profile-card"><div><b>${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.state?.values?.name || '未命名')} · ${escapeHtml(profile.state?.values?.faction || '')} · ${new Date(profile.updatedAt).toLocaleString()}</small></div><div><button type="button" data-profile-action="load" data-profile-id="${profile.id}">加载</button><button type="button" data-profile-action="export" data-profile-id="${profile.id}">导出</button><button type="button" class="danger" data-profile-action="delete" data-profile-id="${profile.id}">删除</button></div></div>`).join('') || '<div class="empty-state">还没有保存的人物档案</div>';
}

function renderSetupSummary() {
    const values = Object.fromEntries(new FormData($('#setupForm')));
    const chosen = starterItems().filter(item => selectedStarterIds.has(item.id));
    const plot = openingData?.plots?.find(item => item.id === selectedPlotId);
    $('#setupSummary').innerHTML = `<div><small>轮回者</small><b>${escapeHtml(values.name || '未命名')} · ${escapeHtml(values.race || '人类')} · ${escapeHtml(values.faction || '')}</b></div><div><small>五维潜质</small><b>${attributeKeys.map(key => `${key}${qualityLevels[attributePoints[key]]}`).join(' · ')}</b></div><div><small>初始兑换</small><b>${chosen.map(item => item.name).join('、') || '无'}（余额 ${setupBalance()}）</b></div><div><small>降临</small><b>${escapeHtml(values.mode === '候选世界' ? plot?.name || '未选择' : values.mode === '单一世界' ? values.targetWorld || '未填写' : '主神空间')}</b></div><div><small>队友</small><b>${values.partnerEnabled === 'on' ? `${escapeHtml(values.partnerName || '未命名')} · ${escapeHtml(values.partnerTier)}级` : '无'}</b></div>`;
    renderProfiles();
}

function showSetupStep(next) {
    setupStep = Math.max(0, Math.min(4, next));
    $$('.setup-step').forEach((node, index) => node.classList.toggle('active', index === setupStep));
    $$('.setup-progress i').forEach((node, index) => node.classList.toggle('active', index <= setupStep));
    $('#setupStepLabel').textContent = `${setupStep + 1} / 5 · ${['信息 / 属性', '初始折扣兑换', '世界 / 降临', '队友创建', '档案确认'][setupStep]}`;
    $('#setupPrev').disabled = setupStep === 0;
    $('#setupNext').classList.toggle('hidden', setupStep === 4);
    $('#setupSubmit').classList.toggle('hidden', setupStep !== 4);
    if (setupStep === 4) renderSetupSummary();
}

async function openSetup() {
    const player = runtime.variables.stat_data?.['主角'] ?? {};
    const form = $('#setupForm');
    form.elements.name.value = store.data.settings.userName || '';
    form.elements.race.value = player['种族'] || '人类';
    setupStep = 0;
    const initialBloodline = Object.values(player['血统'] || {}).find(item => item?.标签?.includes('初始血统'));
    attributePoints = Object.fromEntries(attributeKeys.map(key => [key, Math.max(0, qualityLevels.indexOf(initialBloodline?.原始属性?.[key] || 'F'))]));
    loadPersonalShopState(); selectedPlotId = null;
    renderAttributeBuilder(); renderSetupShop(); renderSetupPlots(); renderPartnerState(); showSetupStep(0); $('#setupDialog').showModal();
}

async function submitSetup(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const variables = structuredClone(runtime.variables);
    const stat = variables.stat_data;
    stat['主角']['种族'] = values.race;
    stat['主角']['身份'] = [values.faction, `${values.age}岁`, values.gender];
    const bloodlineName = `${values.race || '人类'}血统`;
    stat['主角']['血统'] = { [bloodlineName]: { 品质: 'F', 标签: ['初始血统', values.race || '人类'], 原始属性: Object.fromEntries(attributeKeys.map(key => [key, qualityLevels[attributePoints[key]]])), 效果: {}, 描述: '最初的基础，却有无限可能' } };
    const chosen = starterItems().filter(item => selectedStarterIds.has(item.id));
    stat['主角']['装备'] = {}; stat['主角']['道具'] = {}; stat['主角']['技能'] = {};
    for (const item of chosen) {
        if (item._cat === 'equipment') {
            const exportType = item.type <= 9 ? 0 : item.type - 9;
            stat['主角']['装备'][item.name] = { 品质: item.tier, 类型: exportType, 标签: [...(item.tags || []), ...(item.source ? [item.source] : [])], 原始属性: item.attrs || {}, 效果: item.effects || {}, 描述: item.desc || '', 消耗: item.consume || '', 状态: 0 };
        } else if (item._cat === 'item') stat['主角']['道具'][item.name] = { 品质: item.tier, 类型: item.type, 数量: 1, 标签: [...(item.tags || []), ...(item.source ? [item.source] : [])], 效果: item.effects || {}, 描述: item.desc || '' };
        else stat['主角']['技能'][item.name] = { 品质: item.tier, 类型: item.type, 标签: [...(item.tags || []), ...(item.source ? [item.source] : [])], 效果: item.effects || {}, 描述: item.desc || '', 消耗: item.consume || '' };
    }
    stat['主角']['空间币'] = setupBalance();
    stat['设置']['单一世界'] = values.mode === '单一世界';
    stat['设置']['世界超稳'] = values.worldLock === 'on';
    const plot = openingData?.plots?.find(item => item.id === selectedPlotId);
    if (values.mode === '候选世界' && plot) {
        stat['世界']['名称'] = plot.name.match(/【(.*?)】/)?.[1] || plot.name; stat['世界']['时间'] = plot.time || ''; stat['世界']['位格'] = plot.rank || 'Ⅰ'; stat['世界']['难度'] = String(plot.tier || 'F~E').replace(/[-–—]/g, '~');
        stat['世界']['异端雷达'] = { 当前模式: plot.ecology || plot.eco || '', 异端上限: Number(plot.aliens || 0), 活跃余量: Number(plot.aliens || 0) }; stat['系统状态']['是否在主神空间'] = false;
    } else if (values.mode === '单一世界' && values.targetWorld) {
        stat['世界']['名称'] = values.targetWorld;
        stat['世界']['时间'] = values.worldTime || ''; stat['世界']['因果轨道'] = { 当前阶段: values.worldState || '未设定', 故事线: '', 下一节点: '', 偏移记录: {} };
        stat['系统状态']['是否在主神空间'] = false;
    } else stat['系统状态']['是否在主神空间'] = true;
    stat['关系列表'] = stat['关系列表'] || {};
    if (values.partnerEnabled === 'on') {
        if (!values.partnerName?.trim()) return toast('启用队友后必须填写队友姓名', 'error');
        stat['关系列表'][values.partnerName.trim()] = { 在场: true, 种族: values.partnerRace || '人类', 身份: [values.faction, values.partnerGender], 职业: {}, 层级: values.partnerTier, HP: 20, HP_MAX: 20, THP: 0, EP: 0, EP_MAX: 0, 状态: {}, 最终属性: {}, 血统: {}, 装备: {}, 技能: {}, 道具: {}, 形态库: {}, 当前形态: { 激活: false, 名称: '' }, 性格: '', 喜爱: values.partnerLikes || '', 外貌: values.partnerAppearance || '', 着装: '', 是否队友: true, 好感度: 0, 好感度关系: {}, 心里话: '', 背景故事: values.partnerBackground || '' };
    }
    store.updateSettings({ userName: values.name, persona: [`姓名：${values.name}`, `年龄：${values.age}`, `性别：${values.gender}`, `种族：${values.race}`, `阵营：${values.faction}`].join('\n') });
    await runtime.replaceVariables(variables);
    const committed = runtime.variables.stat_data;
    if (!committed?.主角?.血统?.[bloodlineName] || committed.主角.空间币 !== setupBalance()) throw new Error('MVU 建档提交校验失败，变量未正确落盘');
    $('#setupDialog').close();
    const worldText = values.mode === '候选世界' && plot ? `【${plot.name}】\n[时间锚点]：${plot.time}\n[主线状态]：${plot.deviation}\n[切入身份]：${plot.identity}\n[主神任务]：${plot.identityMissions?.[values.faction] || ''}` : values.mode === '单一世界' ? `【${values.targetWorld}】\n[时间锚点]：${values.worldTime}\n[主线状态]：${values.worldState}\n[切入身份]：${values.worldIdentity}\n[主神任务]：${values.worldGoal}` : '当前处于主神空间待机状态，未锚定具体世界。';
    const partnerText = values.partnerEnabled === 'on' ? `专属伙伴：${values.partnerName}，${values.partnerRace}，${values.partnerTier}级。请按 NPC 生成规则补全其血统、技能和 1~2 件初始装备，但不得替换已写入的基础档案。` : '无协同实体。';
    const prompt = `【轮回者建档完成】\n系统已将初始装备、道具、技能、血统、空间币和伙伴精准写入 stat_data，禁止替换或重复发放。\n\n【角色信息】\n姓名：${values.name}\n性别：${values.gender}\n年龄：${values.age}岁\n种族：${values.race}\n身份：${values.faction}\n初始血统：${bloodlineName}（F级；${attributeKeys.map(key => `${key}${qualityLevels[attributePoints[key]]}`).join('、')}）\n\n【初始兑换】\n${chosen.map(item => `${item.name}(${item.tier})`).join('、') || '无'}\n剩余空间币：${setupBalance()}\n\n【协同实体】\n${partnerText}\n\n【世界与降临信息】\n${worldText}\n\n进行开局初始化并展开沉浸式场景。根据种族为初始血统设计 1~2 个符合 F 级限制的效果；已写入字段只可补全，不可清空。必须在末尾输出合法 <UpdateVariable><JSONPatch>，Patch 路径相对于 stat_data。`;
    showPanel('chat');
    $('#messageInput').value = prompt;
    $('#messageInput').dispatchEvent(new Event('input'));
    renderAll();
    await blackbox.record('setup', 'character_profile_committed', { profile: collectProfileState(), statData: committed }, { sessionId: store.activeSession?.id });
    toast('完整人物档案已写入 MVU，确认后即可执行开局。', 'success');
}

function bindEvents() {
    $('#composer').addEventListener('submit', event => {
        event.preventDefault();
        const input = $('#messageInput');
        const text = input.value;
        input.value = '';
        input.style.height = '';
        generate({ text });
    });
    $('#messageInput').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            $('#composer').requestSubmit();
        }
    });
    $('#messageInput').addEventListener('input', event => {
        event.target.style.height = 'auto';
        event.target.style.height = `${Math.min(160, event.target.scrollHeight)}px`;
    });
    document.addEventListener('click', async event => {
        const settingsTab = event.target.closest('[data-settings-tab]')?.dataset.settingsTab;
        if (settingsTab) {
            $$('.settings-tabs [data-settings-tab]').forEach(button => button.classList.toggle('active', button.dataset.settingsTab === settingsTab));
            $$('[data-settings-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.settingsPanel === settingsTab));
            blackbox.record('ui', 'settings_tab_opened', { tab: settingsTab }, { sessionId: store.activeSession?.id });
            if (settingsTab === 'blackbox') renderBlackBox();
            return;
        }
        const connectionItem = event.target.closest('[data-connection-id]');
        if (connectionItem) {
            store.selectConnection(connectionItem.dataset.connectionId);
            editConnection(store.data.connections.find(item => item.id === connectionItem.dataset.connectionId));
            renderConnectionManager();
            return;
        }
        const presetItem = event.target.closest('[data-preset-id]');
        if (presetItem) { selectedPresetId = presetItem.dataset.presetId; selectedPromptEntryId = null; renderPresetManager(); return; }
        const promptEntry = event.target.closest('[data-prompt-id]');
        if (promptEntry && !event.target.matches('[data-prompt-toggle]')) { selectedPromptEntryId = promptEntry.dataset.promptId; renderPresetManager(); return; }
        const scriptItem = event.target.closest('[data-script-id]');
        if (scriptItem) { selectedScriptId = scriptItem.dataset.scriptId; renderScriptManager(); return; }
        const regexItem = event.target.closest('[data-regex-preset-id]');
        if (regexItem) { selectedRegexPresetId = regexItem.dataset.regexPresetId; selectedRegexEntryId = null; renderRegexManager(); return; }
        const regexEntry = event.target.closest('[data-regex-entry-id]');
        if (regexEntry && !event.target.matches('[data-regex-toggle]')) { selectedRegexEntryId = regexEntry.dataset.regexEntryId; renderRegexManager(); return; }
        const modelOption = event.target.closest('[data-model-option]');
        if (modelOption) {
            $('#connectionForm').elements.model.value = modelOption.dataset.modelOption;
            $('#connectionModelOptions').classList.remove('open');
            return;
        }
        const starter = event.target.closest('[data-starter-id]');
        if (starter) {
            const personal = Boolean(starter.closest('#view-shop'));
            const id = starter.dataset.starterId; const item = (personal ? personalShopItems() : starterItems()).find(entry => entry.id === id);
            if (selectedStarterIds.has(id)) selectedStarterIds.delete(id);
            else if (item && (personal ? personalShopBalance() : setupBalance()) >= Number(item.cost || 0)) selectedStarterIds.add(id);
            else return toast('剩余空间币不足', 'error');
            persistPersonalShopState(); renderSetupShop(); renderPersonalShop(); return;
        }
        const setupCategory = event.target.closest('[data-setup-shop-category]');
        if (setupCategory) { setupShopCategory = setupCategory.dataset.setupShopCategory; $$('[data-setup-shop-category]').forEach(button => button.classList.toggle('active', button === setupCategory)); renderSetupShop(); return; }
        const setupRarity = event.target.closest('[data-setup-shop-rarity]');
        if (setupRarity) { setupShopRarity = setupRarity.dataset.setupShopRarity; $$('[data-setup-shop-rarity]').forEach(button => button.classList.toggle('active', button === setupRarity)); renderSetupShop(); return; }
        const personalCategory = event.target.closest('[data-personal-shop-category]');
        if (personalCategory) { personalShopCategory = personalCategory.dataset.personalShopCategory; renderPersonalShop(); return; }
        const personalRarity = event.target.closest('[data-personal-shop-rarity]');
        if (personalRarity) { personalShopRarity = personalRarity.dataset.personalShopRarity; renderPersonalShop(); return; }
        const plotButton = event.target.closest('[data-plot-id]');
        if (plotButton) { selectedPlotId = plotButton.dataset.plotId; $('#setupForm').elements.mode.value = '候选世界'; renderSetupPlots(); return; }
        const profileAction = event.target.closest('[data-profile-action]');
        if (profileAction) {
            const profile = profiles.find(item => item.id === profileAction.dataset.profileId); if (!profile) return;
            if (profileAction.dataset.profileAction === 'load') { applyProfileState(profile.state); $('#profileName').value = profile.name; toast(`已加载档案：${profile.name}`, 'success'); }
            if (profileAction.dataset.profileAction === 'delete' && confirm(`删除人物档案“${profile.name}”？`)) { await library.delete('profiles', profile.id); profiles = profiles.filter(item => item.id !== profile.id); renderProfiles(); }
            if (profileAction.dataset.profileAction === 'export') { const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'reincarnation-character-profile', version: 1, profile }, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${profile.name}.json`; link.click(); URL.revokeObjectURL(url); }
            return;
        }
        const panel = event.target.closest('[data-panel]')?.dataset.panel;
        if (panel) return showPanel(panel);
        const prompt = event.target.closest('[data-prompt]')?.dataset.prompt;
        if (prompt) {
            showPanel('chat');
            $('#messageInput').value = prompt;
            $('#messageInput').dispatchEvent(new Event('input'));
            $('#messageInput').focus();
            return;
        }
        const nativePrompt = event.target.closest('[data-native-prompt]')?.dataset.nativePrompt;
        if (nativePrompt) {
            showPanel('chat');
            $('#messageInput').value = nativePrompt;
            $('#messageInput').dispatchEvent(new Event('input'));
            $('#messageInput').focus();
            return;
        }
        const action = event.target.closest('[data-action]')?.dataset.action;
        const combatMove = event.target.closest('[data-combat-move]');
        if (combatMove) { try { await mutateCombat('commands', { type: 'move', actorId: combatState.activeUnitId, zoneId: combatMove.dataset.combatMove }); } catch (error) { toast(`移动失败：${error.message}`, 'error'); } return; }
        const combatReaction = event.target.closest('[data-combat-reaction]');
        if (combatReaction) { try { await mutateCombat('reactions', { choice: combatReaction.dataset.combatReaction }); } catch (error) { toast(`反应提交失败：${error.message}`, 'error'); } return; }
        const combatAbility = event.target.closest('[data-combat-ability]');
        if (combatAbility) {
            try { await mutateCombat('commands', { type: combatAbility.dataset.combatScript === 'true' ? 'script' : 'attack', actorId: combatState.activeUnitId, abilityId: combatAbility.dataset.combatAbility, targetIds: [combatAbility.dataset.combatTarget] }); }
            catch (error) { toast(`行动失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-new') {
            openTextEditor({ title: '新建本地权威遭遇 · EncounterDraft', value: JSON.stringify(defaultEncounter(), null, 2), mode: 'json', onSave: async text => { try { await createCombatFromEditor(text); $('#textEditorDialog').close(); } catch (error) { toast(`遭遇创建失败：${error.message}`, 'error'); throw error; } } });
            return;
        }
        if (action === 'combat-draft-ai') { try { await draftCombatWithAi(); } catch (error) { toast(`遭遇识别失败：${error.message}`, 'error'); } return; }
        if (action === 'combat-start') { try { await mutateCombat('start', { mode: $('#combatMode').value }); } catch (error) { toast(`无法开始：${error.message}`, 'error'); } return; }
        if (action === 'combat-advance') { try { await mutateCombat('advance', { mode: $('#combatMode').value, maxActions: 10000 }); } catch (error) { toast(`推进失败：${error.message}`, 'error'); } return; }
        if (action === 'combat-wait') { try { await mutateCombat('commands', { type: 'wait', actorId: combatState.activeUnitId }); } catch (error) { toast(`行动失败：${error.message}`, 'error'); } return; }
        if (action === 'combat-refresh') { await loadCombat(); return; }
        if (action === 'combat-toggle-cohorts') { combatShowCohorts = !combatShowCohorts; renderCombat(); return; }
        if (action === 'combat-compile-strategy' || action === 'combat-confirm-strategy') {
            if (!combatState) return toast('请先建立遭遇', 'error');
            try { await compileCombatStrategy(action === 'combat-confirm-strategy'); }
            catch (error) { toast(`策略编译失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-inspect-script') {
            const review = combatState?.pauseReason?.inspection;
            if (!review) return;
            try {
                pendingCombatScriptReview = await combatRequest(`/${combatState.id}/scripts/inspect`, { method: 'POST', body: JSON.stringify({ source: review.source, ability: review.ability }) });
                openTextEditor({ title: `只读能力脚本审查 · ${review.ability?.name || review.hash}`, value: `${review.source}\n\n/*\n固定种子测试：${pendingCombatScriptReview.passed ? '100 / 100 通过' : '失败'}\n权限：${pendingCombatScriptReview.capabilities.join(', ') || '无'}\n限制：${JSON.stringify(pendingCombatScriptReview.limits)}\n失败：${JSON.stringify(pendingCombatScriptReview.failures, null, 2)}\n*/`, mode: 'text', readonly: true });
                renderCombat();
            } catch (error) { toast(`脚本审查失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-approve-script') {
            const review = combatState?.pauseReason?.inspection;
            if (!review || !pendingCombatScriptReview?.passed || pendingCombatScriptReview.hash !== review.hash) return toast('必须先通过固定种子审查', 'error');
            try { await mutateCombat(`scripts/${review.hash}/approve`, { source: review.source, ability: review.ability }); pendingCombatScriptReview = null; toast('脚本版本已批准并缓存；规则或源码改变后会重新审批。', 'success'); }
            catch (error) { toast(`脚本审批失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-replay') {
            if (!combatState) return toast('暂无战斗重放', 'error');
            try { const replay = await combatRequest(`/${combatState.id}/replay`); openTextEditor({ title: `只读战斗重放 · ${combatState.id}`, value: JSON.stringify(replay, null, 2), mode: 'json', readonly: true }); }
            catch (error) { toast(`重放读取失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-narrate') { try { await narrateCombat(); } catch (error) { toast(`战报融合失败：${error.message}`, 'error'); await blackbox.record('combat', 'narration_failed', { battleId: combatState?.id, error }, { sessionId: store.activeSession?.id }); } return; }
        if (action) blackbox.record('ui', 'action_clicked', { action }, { sessionId: store.activeSession?.id });
        if (action === 'refresh-personal-shop') { await refreshPersonalShop(); return; }
        if (action === 'toggle-rail') $('#rail').classList.toggle('open');
        if (action === 'toggle-nav-category') {
            const category = event.target.closest('.nav-category');
            const collapsed = category.classList.toggle('collapsed');
            event.target.closest('.nav-category-toggle').setAttribute('aria-expanded', String(!collapsed));
        }
        if (action === 'floor-prev' || action === 'floor-next') {
            const session = store.activeSession;
            if (session) {
                const current = storyFloorBySession.get(session.id) ?? collectStoryFloors(session.messages).length - 1;
                storyFloorBySession.set(session.id, current + (action === 'floor-prev' ? -1 : 1));
                renderMessages();
                await blackbox.record('ui', 'story_floor_changed', { floor: storyFloorBySession.get(session.id) + 1 }, { sessionId: session.id });
            }
        }
        if (action === 'view-floor-prompt') {
            const trace = currentStoryFloor()?.narrative?.promptTrace;
            if (trace) openTextEditor({ title: '本楼实际发送 Prompt · 只读', value: JSON.stringify(trace, null, 2), mode: 'json', readonly: true });
        }
        if (action === 'view-floor-tokens') {
            const usage = currentStoryFloor()?.narrative?.tokenUsage;
            if (usage) openTextEditor({ title: `本楼 Token 明细 · ${usage.exact ? 'API 实际值' : '本地估算'}`, value: JSON.stringify(usage, null, 2), mode: 'json', readonly: true });
        }
        if (action === 'edit-floor') {
            const floor = currentStoryFloor(); const message = floor?.narrative || floor?.actions.at(-1);
            if (message) openTextEditor({ title: `编辑第 ${(storyFloorBySession.get(store.activeSession.id) ?? 0) + 1} 楼`, value: message.content, mode: 'text', onSave: async value => { store.updateMessage(message.id, value); renderAll(); await blackbox.record('editor', 'story_floor_saved', { messageId: message.id, length: value.length }, { sessionId: store.activeSession?.id }); } });
        }
        if (action === 'regen-floor') {
            const message = currentStoryFloor()?.narrative;
            if (message) await handleMessageAction(message.id, 'regen');
        }
        if (action === 'delete-floor') {
            const floor = currentStoryFloor(); const message = floor?.actions[0] || floor?.narrative;
            if (message && confirm('从当前剧情楼层开始删除后续记录？')) { store.removeFrom(message.id); storyFloorBySession.set(store.activeSession.id, collectStoryFloors(store.activeSession.messages).length - 1); renderAll(); }
        }
        if (action === 'open-setup-shop') { await openSetup(); showSetupStep(1); }
        if (action === 'home') showPanel('hub');
        if (action === 'toggle-actions') $('#quickActions').classList.toggle('hidden');
        if (action === 'cancel-generation' && generationController) {
            await blackbox.record('turn', 'generation_cancel_requested', {}, { sessionId: store.activeSession?.id });
            generationController.abort(new DOMException('用户已中止生成', 'AbortError'));
        }
        if (action === 'roll') {
            const roll = 1 + Math.floor(Math.random() * 100);
            const input = $('#messageInput');
            input.value += `${input.value ? '\n' : ''}【D100：${roll}】`;
            input.dispatchEvent(new Event('input'));
        }
        if (action === 'new-chat') await newSession();
        if (action === 'enter-game') {
            const first = store.activeSession?.messages[0];
            if (first) {
                first.swipeIndex = 1;
                first.content = runtime.card.alternate_greetings?.[0] || '【开局】';
                store.save();
                renderAll();
            }
        }
        if (action === 'open-setup') openSetup();
        if (action === 'close-setup') $('#setupDialog').close();
        if (action === 'setup-prev') showSetupStep(setupStep - 1);
        if (action === 'open-profiles') { showSetupStep(4); renderSetupSummary(); }
        if (action === 'setup-next') {
            if (setupStep === 0 && !$('#setupForm').reportValidity()) return;
            if (setupStep === 1 && setupBalance() < 0) return toast('初始兑换已超出空间币预算', 'error');
            if (setupStep === 2 && $('#setupForm').elements.mode.value === '候选世界' && !selectedPlotId) return toast('请选择一个候选世界', 'error');
            if (setupStep === 3 && $('#setupForm').elements.partnerEnabled.checked && !$('#setupForm').elements.partnerName.value.trim()) return toast('请填写队友姓名', 'error');
            if (setupBalance() < 0) return toast('空间币不足以支付队友建档费用', 'error');
            showSetupStep(setupStep + 1);
        }
        if (action === 'save-profile') {
            const name = $('#profileName').value.trim(); if (!name) return toast('请输入档案名称', 'error');
            const existing = profiles.find(item => item.name === name);
            const profile = { id: existing?.id || crypto.randomUUID(), name, state: collectProfileState(), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
            await library.put('profiles', profile); profiles = profiles.filter(item => item.id !== profile.id).concat(profile); renderProfiles(); toast(`人物档案“${name}”已保存`, 'success');
        }
        if (action === 'import-profile') $('#profileFile').click();
        if (action === 'add-custom-starter') {
            try {
                const name = $('#customStarterName').value.trim(); if (!name) throw new Error('请填写名称');
                const effects = JSON.parse($('#customStarterEffects').value || '{}');
                const category = $('#customStarterCategory').value;
                const item = { id: `custom-${crypto.randomUUID()}`, name, tier: $('#customStarterTier').value, cost: Number($('#customStarterCost').value || 0), type: category === 'equipment' ? 9 : category === 'skill' ? 2 : '特殊', source: '自定义', tags: $('#customStarterTags').value.split(/[,，]/).map(item => item.trim()).filter(Boolean), attrs: {}, effects, desc: $('#customStarterDescription').value.trim(), consume: '', _cat: category, custom: true };
                if (item.cost < 0) throw new Error('空间币消耗不能为负数');
                customStarterItems.push(item); selectedStarterIds.add(item.id); persistPersonalShopState(); $('#customStarterName').value = ''; renderSetupShop(); renderPersonalShop(); toast(`已创建并选择：${name}`, 'success');
            } catch (error) { toast(`自定义兑换项创建失败：${error.message}`, 'error'); }
        }
        if (action === 'save-settings') {
            const values = Object.fromEntries(new FormData($('#settingsForm')));
            store.updateSettings(values);
            applyUiScale();
            toast('常规设置已保存', 'success');
        }
        if (action === 'new-connection') editConnection();
        if (action === 'delete-connection') {
            const id = $('#connectionForm').elements.id.value;
            if (id && confirm('删除这条 API 连接配置？')) {
                store.deleteConnection(id);
                editConnection(store.data.connections.find(item => item.id === store.data.settings.activeConnectionId) || null);
                renderConnectionManager();
            }
        }
        if (action === 'fetch-models') await fetchModels();
        if (action === 'test-connection') await testConnection();
        if (action === 'import-connections') $('#connectionFile').click();
        if (action === 'export-connections') exportConnections();
        if (action === 'import-preset') $('#presetFile').click();
        if (action === 'add-prompt-entry') {
            const preset = presets.find(item => item.id === selectedPresetId); if (!preset) return toast('请先选择预设', 'error');
            const prompt = { identifier: crypto.randomUUID(), name: '新提示词', role: 'system', content: '', marker: false, enabled: true, order: preset.prompts.length, injectionPosition: 0, injectionDepth: 4 };
            preset.prompts.push(prompt); selectedPromptEntryId = prompt.identifier; await library.put('presets', preset); if (preset.id === store.data.settings.activePresetId) runtime.setPreset(preset); renderPresetManager();
        }
        if (['move-prompt-up', 'move-prompt-down'].includes(action)) {
            const preset = presets.find(item => item.id === selectedPresetId); const index = preset?.prompts.findIndex(item => item.identifier === selectedPromptEntryId) ?? -1; const target = action.endsWith('up') ? index - 1 : index + 1;
            if (preset && index >= 0 && target >= 0 && target < preset.prompts.length) { [preset.prompts[index], preset.prompts[target]] = [preset.prompts[target], preset.prompts[index]]; preset.prompts.forEach((item, order) => { item.order = order; }); await library.put('presets', preset); renderPresetManager(); }
        }
        if (action === 'delete-prompt-entry') {
            const preset = presets.find(item => item.id === selectedPresetId); const index = preset?.prompts.findIndex(item => item.identifier === selectedPromptEntryId) ?? -1;
            if (preset && index >= 0 && confirm(`删除提示词“${preset.prompts[index].name}”？`)) { preset.prompts.splice(index, 1); selectedPromptEntryId = preset.prompts[Math.min(index, preset.prompts.length - 1)]?.identifier || null; await library.put('presets', preset); if (preset.id === store.data.settings.activePresetId) runtime.setPreset(preset); renderPresetManager(); }
        }
        if (action === 'edit-preset-source') {
            const preset = presets.find(item => item.id === selectedPresetId);
            if (!preset) return toast('请先选择一个预设', 'error');
            const source = JSON.stringify(rawFromPresetBridge(presetBridgeValue(preset)), null, 2);
            openTextEditor({ title: `编辑预设 · ${preset.name}`, value: source, onSave: async text => {
                const value = JSON.parse(text);
                await saveBridgePreset(preset.name, value, preset);
                await blackbox.record('editor', 'preset_saved', { presetId: preset.id, name: preset.name, beforeLength: source.length, afterLength: text.length });
            } });
        }
        if (action === 'activate-preset') {
            const preset = presets.find(item => item.id === selectedPresetId);
            if (preset) {
                store.updateSettings({ activePresetId: preset.id });
                runtime.setPreset(preset);
                renderPresetManager();
                toast(`已启用 AIRP 预设：${preset.name}`, 'success');
            }
        }
        if (action === 'delete-preset') {
            const preset = presets.find(item => item.id === selectedPresetId);
            if (preset && confirm(`删除预设“${preset.name}”？`)) {
                await library.delete('presets', preset.id);
                presets = presets.filter(item => item.id !== preset.id);
                if (store.data.settings.activePresetId === preset.id) { store.updateSettings({ activePresetId: null }); runtime.setPreset(null); }
                selectedPresetId = presets[0]?.id || null; renderPresetManager();
            }
        }
        if (action === 'import-script') $('#scriptFile').click();
        if (action === 'import-regex-preset') $('#regexPresetFile').click();
        if (action === 'add-regex-entry') {
            const preset = await editableRegexPreset(); const rule = { id: crypto.randomUUID(), scriptName: '新正则', disabled: false, runOnEdit: false, findRegex: '', replaceString: '', trimStrings: [], placement: [1, 2], substituteRegex: 0, minDepth: null, maxDepth: null, markdownOnly: false, promptOnly: false };
            preset.scripts.push(rule); selectedRegexEntryId = rule.id; await library.put('regexPresets', preset); runtime.setRegexPresets(regexPresets); renderRegexManager();
        }
        if (['move-regex-up', 'move-regex-down'].includes(action)) {
            const preset = await editableRegexPreset(); const index = preset.scripts.findIndex(item => item.id === selectedRegexEntryId); const target = action.endsWith('up') ? index - 1 : index + 1;
            if (index >= 0 && target >= 0 && target < preset.scripts.length) { [preset.scripts[index], preset.scripts[target]] = [preset.scripts[target], preset.scripts[index]]; await library.put('regexPresets', preset); runtime.setRegexPresets(regexPresets); renderRegexManager(); renderMessages(); }
        }
        if (action === 'delete-regex-entry') {
            const preset = await editableRegexPreset(); const index = preset.scripts.findIndex(item => item.id === selectedRegexEntryId);
            if (index >= 0 && confirm(`删除正则“${preset.scripts[index].scriptName}”？`)) { preset.scripts.splice(index, 1); selectedRegexEntryId = preset.scripts[Math.min(index, preset.scripts.length - 1)]?.id || null; await library.put('regexPresets', preset); runtime.setRegexPresets(regexPresets); renderRegexManager(); renderMessages(); }
        }
        if (action === 'toggle-regex-preset') {
            const preset = regexPresets.find(item => item.id === selectedRegexPresetId); if (!preset) return toast('角色卡内置正则不能整体停用', 'error');
            preset.enabled = !preset.enabled; await library.put('regexPresets', preset); runtime.setRegexPresets(regexPresets); renderRegexManager(); renderMessages();
        }
        if (action === 'delete-regex-preset') {
            const preset = regexPresets.find(item => item.id === selectedRegexPresetId); if (!preset) return toast('角色卡内置正则不能删除', 'error');
            if (confirm(`删除正则预设“${preset.name}”？`)) { await library.delete('regexPresets', preset.id); regexPresets = regexPresets.filter(item => item.id !== preset.id); selectedRegexPresetId = 'card'; runtime.setRegexPresets(regexPresets); renderRegexManager(); }
        }
        if (action === 'edit-regex-preset') {
            const preset = selectedRegexPresetId === 'card' ? { name: '角色卡内置正则（只读副本）', scripts: runtime.card.extensions.regex_scripts } : regexPresets.find(item => item.id === selectedRegexPresetId);
            if (!preset) return;
            const source = JSON.stringify({ name: preset.name, enabled: preset.enabled !== false, scripts: preset.scripts }, null, 2);
            openTextEditor({ title: `编辑正则预设 · ${preset.name}`, value: source, onSave: selectedRegexPresetId === 'card' ? async text => {
                const imported = normalizeRegexPreset(JSON.parse(text), '卡内正则副本.json'); imported.name = '卡内正则副本'; await library.put('regexPresets', imported); regexPresets.push(imported); selectedRegexPresetId = imported.id; runtime.setRegexPresets(regexPresets); renderRegexManager();
            } : async text => {
                const imported = normalizeRegexPreset(JSON.parse(text), `${preset.name}.json`); imported.id = preset.id; imported.name = preset.name; await library.put('regexPresets', imported); regexPresets = regexPresets.filter(item => item.id !== preset.id).concat(imported); runtime.setRegexPresets(regexPresets); renderRegexManager(); renderMessages();
            } });
        }
        if (action === 'import-script-url') {
            const input = $('#scriptUrl'); const url = input.value.trim();
            if (!url) return toast('请先填写助手脚本 URL', 'error');
            const button = event.target.closest('[data-action="import-script-url"]'); button.disabled = true; button.textContent = '导入中…';
            try { await importScriptUrl(url); input.value = ''; }
            catch (error) { toast(`URL 导入失败：${error.message}`, 'error'); }
            finally { button.disabled = false; button.textContent = 'URL 导入'; }
        }
        if (action === 'toggle-script') {
            const script = scripts.find(item => item.id === selectedScriptId);
            if (script) {
                script.enabled = !script.enabled; await library.put('scripts', script);
                if (script.enabled) executeAssistantScript(script).catch(error => toast(`${script.name} 启动失败：${error.message}`, 'error'));
                else stopAssistantScript(script.id);
                renderScriptManager();
            }
        }
        if (action === 'open-script-ui') openAssistantScriptUi(selectedScriptId);
        if (action === 'delete-script') {
            const script = scripts.find(item => item.id === selectedScriptId);
            if (script && confirm(`删除脚本“${script.name}”？`)) {
                stopAssistantScript(script.id); await library.delete('scripts', script.id);
                scripts = scripts.filter(item => item.id !== script.id); selectedScriptId = scripts[0]?.id || null; renderScriptManager();
            }
        }
        if (action === 'export-save') exportSave();
        if (action === 'export-blackbox') {
            let combatReplay = null;
            try { if (activeBattleId()) combatReplay = await combatRequest(`/${activeBattleId()}/replay`); } catch (error) { combatReplay = { error: error.message, battleId: activeBattleId() }; }
            await blackbox.exportCurrent({
                store: store.data,
                activePreset: runtime.activePreset ? { id: runtime.activePreset.id, name: runtime.activePreset.name } : null,
                card: { name: runtime.card.name, worldbookEntries: runtime.card.character_book?.entries?.length, regexScripts: runtime.card.extensions?.regex_scripts?.length },
                scripts: scripts.map(item => ({ id: item.id, name: item.name, enabled: item.enabled, sourceUrl: item.sourceUrl })),
                combatReplay,
            });
        }
        if (action === 'clear-blackbox' && confirm('清空所有本机黑盒历史并开始一段新的记录？')) { await blackbox.clear(); await renderBlackBox(); }
        const messageAction = event.target.closest('[data-message-action]');
        if (messageAction) await handleMessageAction(messageAction.closest('.message').dataset.id, messageAction.dataset.messageAction);
        const archive = event.target.closest('[data-session]');
        if (archive) { store.selectSession(archive.dataset.session); loadPersonalShopState(); combatState = null; combatEvents = []; pendingCombatScriptReview = null; loadCombat({ quiet: true }); showPanel('hub'); renderAll(); }
        const attribute = event.target.closest('[data-attribute]');
        if (attribute) {
            const key = attribute.dataset.attribute;
            const delta = Number(attribute.dataset.delta);
            const used = Object.values(attributePoints).reduce((sum, value) => sum + value, 0);
            if (delta > 0 && used >= 8) return toast('血统潜质点已全部分配', 'error');
            attributePoints[key] = Math.max(0, Math.min(8, attributePoints[key] + delta));
            renderAttributeBuilder();
        }
        const filter = event.target.closest('[data-filter]');
        if (filter) {
            $$('.filter-tabs button').forEach(button => button.classList.toggle('active', button === filter));
            $$('#inventoryContent .entity-card').forEach(card => card.hidden = filter.dataset.filter !== 'all' && card.dataset.entityType !== filter.dataset.filter);
        }
    });
    document.addEventListener('change', async event => {
        if (event.target.matches('[data-combat-control]')) {
            try { await mutateCombat('control', { unitId: event.target.dataset.combatControl, controller: event.target.checked ? 'player' : 'ai' }); }
            catch (error) { toast(`控制权切换失败：${error.message}`, 'error'); }
            return;
        }
        if (event.target.matches('#combatMode') && combatState) {
            try { await mutateCombat('control', { mode: event.target.value }); } catch (error) { toast(`模式切换失败：${error.message}`, 'error'); }
            return;
        }
        if (event.target.matches('#combatConnection')) { store.updateSettings({ activeCombatConnectionId: event.target.value || null }); renderCombat(); return; }
        if (event.target.matches('#combatPreset')) { store.updateSettings({ activeCombatPresetId: event.target.value || null }); renderCombat(); return; }
        if (event.target.matches('[data-cover-agree]')) {
            event.target.closest('.native-cover').querySelector('[data-action="enter-game"]').disabled = !event.target.checked;
        }
        if (event.target.matches('[data-prompt-toggle]')) {
            const preset = presets.find(item => item.id === selectedPresetId);
            const prompt = preset?.prompts.find(item => item.identifier === event.target.closest('[data-prompt-id]')?.dataset.promptId);
            if (prompt) {
                prompt.enabled = event.target.checked;
                library.put('presets', preset);
                if (preset.id === store.data.settings.activePresetId) runtime.setPreset(preset);
                renderPresetManager();
            }
        }
        if (event.target.matches('[data-regex-toggle]')) {
            const entryId = event.target.closest('[data-regex-entry-id]')?.dataset.regexEntryId;
            selectedRegexEntryId = entryId || selectedRegexEntryId;
            const preset = await editableRegexPreset();
            const rule = preset?.scripts.find(item => item.id === selectedRegexEntryId);
            if (rule) {
                rule.disabled = !event.target.checked;
                await library.put('regexPresets', preset);
                runtime.setRegexPresets(regexPresets);
                await blackbox.record('editor', 'regex_entry_toggled', { presetId: preset.id, ruleId: rule.id, enabled: !rule.disabled });
                renderRegexManager(); renderMessages();
            }
        }
        if (event.target.matches('#regexPresetEnabled')) {
            const preset = regexPresets.find(item => item.id === selectedRegexPresetId);
            if (!preset) return;
            preset.enabled = event.target.checked;
            await library.put('regexPresets', preset);
            runtime.setRegexPresets(regexPresets);
            await blackbox.record('editor', 'regex_preset_toggled', { presetId: preset.id, enabled: preset.enabled });
            renderRegexManager(); renderMessages();
        }
    });
    $('#presetFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = '';
        if (!file) return;
        try { await importPresetFile(file); } catch (error) { toast(`预设导入失败：${error.message}`, 'error'); }
    });
    $('#scriptFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = '';
        if (!file) return;
        try { await importScriptFile(file); } catch (error) { toast(`脚本导入失败：${error.message}`, 'error'); }
    });
    $('#regexPresetFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = ''; if (!file) return;
        try { const preset = normalizeRegexPreset(JSON.parse(await file.text()), file.name); await library.put('regexPresets', preset); regexPresets.push(preset); selectedRegexPresetId = preset.id; runtime.setRegexPresets(regexPresets); renderRegexManager(); renderMessages(); toast(`已导入正则预设：${preset.name}`, 'success'); }
        catch (error) { toast(`正则预设导入失败：${error.message}`, 'error'); }
    });
    $('#scriptUrl').addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); $('[data-action="import-script-url"]').click(); }
    });
    $('#connectionFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = '';
        if (!file) return;
        try { await importConnections(file); } catch (error) { toast(`API 实例导入失败：${error.message}`, 'error'); }
    });
    $('#connectionForm').addEventListener('submit', event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget));
        values.temperature = Number(values.temperature); values.maxTokens = Number(values.maxTokens);
        const saved = store.saveConnection(values); editConnection(saved); renderConnectionManager();
        toast(`连接配置“${saved.name}”已保存并启用`, 'success');
    });
    $('#promptEntryEditor').addEventListener('submit', async event => {
        event.preventDefault();
        const preset = presets.find(item => item.id === selectedPresetId);
        const prompt = preset?.prompts.find(item => item.identifier === selectedPromptEntryId);
        if (!preset || !prompt) return;
        const form = event.currentTarget;
        const before = { name: prompt.name, role: prompt.role, enabled: prompt.enabled, contentLength: prompt.content.length };
        prompt.name = form.elements.name.value.trim() || '未命名提示词';
        prompt.role = form.elements.role.value;
        prompt.content = form.elements.content.value;
        prompt.marker = form.elements.marker.checked;
        prompt.enabled = form.elements.enabled.checked;
        prompt.injectionPosition = Number(form.elements.injectionPosition.value || 0);
        prompt.injectionDepth = Math.max(0, Number(form.elements.injectionDepth.value || 0));
        await library.put('presets', preset);
        if (preset.id === store.data.settings.activePresetId) runtime.setPreset(preset);
        await blackbox.record('editor', 'preset_entry_saved', { presetId: preset.id, promptId: prompt.identifier, before, after: { name: prompt.name, role: prompt.role, enabled: prompt.enabled, contentLength: prompt.content.length } });
        renderPresetManager();
        toast(`提示词“${prompt.name}”已保存`, 'success');
    });
    $('#regexEntryEditor').addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const preset = await editableRegexPreset();
        const rule = preset?.scripts.find(item => item.id === selectedRegexEntryId);
        if (!preset || !rule) return;
        const nullableNumber = name => form.elements[name].value === '' ? null : Math.max(0, Number(form.elements[name].value));
        const before = { scriptName: rule.scriptName, disabled: rule.disabled, findLength: rule.findRegex.length, replaceLength: rule.replaceString.length };
        rule.scriptName = form.elements.scriptName.value.trim() || '未命名正则';
        rule.findRegex = form.elements.findRegex.value;
        rule.replaceString = form.elements.replaceString.value;
        rule.placement = [form.elements.placement1.checked && 1, form.elements.placement2.checked && 2].filter(Boolean);
        rule.promptOnly = form.elements.promptOnly.checked;
        rule.markdownOnly = form.elements.markdownOnly.checked;
        rule.runOnEdit = form.elements.runOnEdit.checked;
        rule.substituteRegex = form.elements.substituteRegex.checked ? 1 : 0;
        rule.minDepth = nullableNumber('minDepth');
        rule.maxDepth = nullableNumber('maxDepth');
        rule.trimStrings = form.elements.trimStrings.value.split(/\r?\n/).filter(item => item.length);
        rule.disabled = !form.elements.enabled.checked;
        await library.put('regexPresets', preset);
        runtime.setRegexPresets(regexPresets);
        await blackbox.record('editor', 'regex_entry_saved', { presetId: preset.id, ruleId: rule.id, before, after: { scriptName: rule.scriptName, disabled: rule.disabled, findLength: rule.findRegex.length, replaceLength: rule.replaceString.length } });
        renderRegexManager(); renderMessages();
        toast(`正则“${rule.scriptName}”已保存`, 'success');
    });
    $('#textEditorValue').addEventListener('input', () => updateTextEditorStatus());
    $('#textEditorValue').addEventListener('scroll', event => { $('#textEditorLines').scrollTop = event.target.scrollTop; });
    $('#textEditorValue').addEventListener('click', () => updateTextEditorStatus());
    $('#textEditorValue').addEventListener('keyup', () => updateTextEditorStatus());
    $('#textEditorValue').addEventListener('keydown', event => {
        if (event.key === 'Tab') {
            event.preventDefault(); const input = event.currentTarget; const start = input.selectionStart;
            input.setRangeText('  ', start, input.selectionEnd, 'end'); updateTextEditorStatus();
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveTextEditor(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); $('#textEditorFind').focus(); }
    });
    $('#textEditorDialog').addEventListener('click', async event => {
        const action = event.target.closest('[data-editor-action]')?.dataset.editorAction;
        if (!action) return;
        if (action === 'close') $('#textEditorDialog').close();
        if (action === 'find-next') findInEditor();
        if (action === 'revert') { $('#textEditorValue').value = textEditorOriginal; updateTextEditorStatus('已恢复打开时内容'); }
        if (action === 'format') { try { $('#textEditorValue').value = JSON.stringify(JSON.parse($('#textEditorValue').value), null, 2); updateTextEditorStatus('JSON 格式化完成'); } catch (error) { updateTextEditorStatus(`JSON 无效：${error.message}`); } }
        if (action === 'replace') { const input = $('#textEditorValue'); const selected = input.value.slice(input.selectionStart, input.selectionEnd); if (selected === $('#textEditorFind').value) input.setRangeText($('#textEditorReplace').value, input.selectionStart, input.selectionEnd, 'end'); findInEditor(); }
        if (action === 'replace-all') { const find = $('#textEditorFind').value; if (find) { const input = $('#textEditorValue'); const count = input.value.split(find).length - 1; input.value = input.value.split(find).join($('#textEditorReplace').value); updateTextEditorStatus(`已替换 ${count} 处`); } }
        if (action === 'save') await saveTextEditor();
    });
    $('#setupForm').addEventListener('submit', submitSetup);
    $('#setupShopSearch').addEventListener('input', renderSetupShop);
    $('#personalShopContent').addEventListener('input', event => { if (event.target.matches('[data-personal-shop-search]')) { personalShopSearch = event.target.value.trim().toLowerCase(); renderPersonalShop(); requestAnimationFrame(() => { const input = $('[data-personal-shop-search]'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }); } });
    $('#setupForm').elements.partnerEnabled.addEventListener('change', () => { renderPartnerState(); renderSetupShop(); });
    $('#setupForm').elements.partnerTier.addEventListener('change', () => { renderPartnerState(); renderSetupShop(); });
    $('#setupForm').elements.mode.forEach(input => input.addEventListener('change', renderSetupPlots));
    $('#profileFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = ''; if (!file) return;
        try {
            const raw = JSON.parse(await file.text()); const source = raw.profile || raw;
            if (!source?.state) throw new Error('缺少人物档案 state');
            const profile = { ...source, id: crypto.randomUUID(), name: source.name || file.name.replace(/\.json$/i, ''), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            await library.put('profiles', profile); profiles.push(profile); renderProfiles(); toast(`已导入人物档案：${profile.name}`, 'success');
        } catch (error) { toast(`人物档案导入失败：${error.message}`, 'error'); }
    });
    $('#connectionForm').elements.temperature.addEventListener('input', event => { $('#temperatureValue').textContent = event.target.value; });
    $('#connectionForm').elements.model.addEventListener('input', event => renderConnectionModelOptions(event.target.value));
    $('#connectionForm').elements.model.addEventListener('focus', event => { if (connectionModelCandidates.length) renderConnectionModelOptions(event.target.value); });
    $('#connectionForm').elements.model.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' && connectionModelCandidates.length) { event.preventDefault(); renderConnectionModelOptions(event.target.value); $('#connectionModelOptions button')?.focus(); }
        if (event.key === 'Escape') $('#connectionModelOptions').classList.remove('open');
    });
    $('#connectionForm').elements.protocol.addEventListener('change', event => {
        const form = event.currentTarget.form; const defaults = protocolDefaults(event.target.value);
        form.elements.baseUrl.value = defaults.baseUrl; form.elements.path.value = defaults.path; form.elements.modelsPath.value = defaults.modelsPath;
        connectionModelCandidates = []; $('#connectionModelOptions').classList.remove('open');
    });
    document.addEventListener('pointerdown', event => { if (!event.target.closest('.model-combo')) $('#connectionModelOptions').classList.remove('open'); });
    runtime.addEventListener('notify', event => toast(event.detail.message, event.detail.type));
    runtime.addEventListener('variables', renderAll);
}

async function handleMessageAction(id, action) {
    const session = store.activeSession;
    const message = session.messages.find(item => item.id === id);
    if (!message) return;
    if (action === 'edit') {
        openTextEditor({ title: '编辑剧情楼层', value: message.content, mode: 'text', onSave: async value => { store.updateMessage(id, value); renderAll(); } });
    } else if (action === 'delete') {
        if (confirm('从这条消息开始删除后续记录？')) { store.removeFrom(id); renderAll(); }
    } else if (action === 'regen') {
        store.removeFrom(id);
        renderAll();
        await generate({ addUser: false });
    }
}

async function fetchModels() {
    const form = $('#connectionForm');
    const values = Object.fromEntries(new FormData(form));
    try {
        const response = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        const ids = (data.data ?? []).map(item => typeof item === 'string' ? item : item.id || item.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
        if (!ids.length) throw new Error('接口未返回模型列表');
        connectionModelCandidates = ids;
        renderConnectionModelOptions(form.elements.model.value);
        $('#connectionTestResult').textContent = `已获取 ${ids.length} 个模型；输入关键词过滤或直接选择`;
    } catch (error) { toast(`获取模型失败：${error.message}`, 'error'); }
}

async function testConnection() {
    const form = $('#connectionForm');
    const values = Object.fromEntries(new FormData(form));
    const result = $('#connectionTestResult');
    result.textContent = '正在连接…';
    try {
        const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, stream: false, temperature: Number(values.temperature), maxTokens: Math.min(64, Number(values.maxTokens) || 64), messages: [{ role: 'user', content: values.testPrompt || '只回复 OK' }] }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        result.textContent = `连接正常 · ${String(data.choices?.[0]?.message?.content || '上游已响应').slice(0, 80)}`;
        result.className = 'ok';
    } catch (error) {
        result.textContent = `连接失败 · ${error.message}`;
        result.className = 'error';
    }
}

async function importConnections(file) {
    const raw = JSON.parse(await file.text());
    const source = Array.isArray(raw) ? raw : Array.isArray(raw.profiles) ? raw.profiles : raw.connections;
    if (!Array.isArray(source) || !source.length) throw new Error('文件中没有 profiles 或 connections 实例数组');
    const items = source.map((item, index) => {
        const config = item?.config || item || {};
        const signature = `${config.baseUrl || ''} ${config.path || ''}`;
        const inferredProtocol = /generateContent|generativelanguage/i.test(signature) ? 'gemini' : /anthropic|\/messages/i.test(signature) ? 'anthropic' : /\/responses/i.test(signature) ? 'openai-responses' : 'openai-chat';
        return {
            ...config,
            id: crypto.randomUUID(),
            name: String(item?.name || `API ${index + 1}`),
            protocol: config.protocol || inferredProtocol,
            maxTokens: config.maxTokens ?? config.maxOutputTokens ?? 8192,
        };
    });
    if (!confirm(`导入会覆盖当前 ${store.data.connections.length} 个 API 实例，确定继续？`)) return;
    store.data.connections = [];
    store.data.settings.activeConnectionId = null;
    let last;
    for (const item of items) {
        if (!item?.name || !item?.baseUrl) continue;
        const defaults = protocolDefaults(item.protocol || 'openai-chat');
        last = store.saveConnection({ ...defaults, extraHeaders: '{}', extraBody: '{}', testPrompt: '只回复 OK', ...item, id: item.id || crypto.randomUUID() });
    }
    if (!last) throw new Error('没有可导入的有效实例');
    editConnection(last); renderConnectionManager(); toast(`已导入 ${items.length} 条 API 实例`, 'success');
}

function exportConnections() {
    if (!confirm('导出的实例集包含 API Key，请只保存在可信位置。确定导出？')) return;
    const profiles = store.data.connections.map(({ id, name, createdAt, updatedAt, ...config }) => ({ id, name, config }));
    const payload = { format: 'comic-orb-api-profiles', version: 1, kind: 'chat', exportedAt: new Date().toISOString(), activeId: store.data.settings.activeConnectionId, profiles };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `comic-orb-chat-apis-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href);
}

function exportSave() {
    const blob = new Blob([store.export()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `轮回战场-${store.activeSession?.title || '存档'}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
}

async function loadOpeningData() {
    const response = await fetch('/api/opening-data');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    openingData = data;
    renderSetupShop(); renderPersonalShop(); renderSetupPlots();
}

async function boot() {
    await blackbox.record('lifecycle', 'boot_started', { savedSessions: store.data.sessions.length, savedConnections: store.data.connections.length });
    try {
        const response = await fetch('/api/card');
        if (!response.ok) throw new Error(await response.text());
        runtime = new CardRuntime(await response.json(), store);
        window.__reincarnationRuntime = runtime;
        if (!store.data.connections.length) {
            store.saveConnection({
                name: '默认 OpenAI 兼容连接', protocol: 'openai-chat', ...protocolDefaults('openai-chat'),
                baseUrl: store.data.settings.baseUrl || 'https://api.openai.com/v1', apiKey: store.data.settings.apiKey || '',
                model: store.data.settings.model || '', temperature: store.data.settings.temperature ?? .9,
                maxTokens: store.data.settings.maxTokens ?? 8192, apiVersion: '', extraHeaders: '{}', extraBody: '{}', testPrompt: '只回复 OK',
            });
        }
        if (!store.activeSession) {
            const session = store.createSession({ firstMessage: runtime.card.first_mes || '【封面】', variables: runtime.createInitialVariables() });
            session.messages[0].swipes = [runtime.card.first_mes, ...(runtime.card.alternate_greetings ?? [])];
            store.save();
        }
        loadPersonalShopState();
        installBridge();
        bindEvents();
        fillSettings();
        renderAll();
        await Promise.all([loadLibraries(), loadOpeningData().catch(error => { toast(error.message, 'error'); blackbox.record('setup', 'opening_data_failed', { error }); })]);
        const result = await runtime.initializeScripts();
        await blackbox.record('runtime', 'card_runtime_initialized', { card: runtime.card.name, worldbookEntries: runtime.card.character_book?.entries?.length, regexScripts: runtime.card.extensions?.regex_scripts?.length, loaded: result.loaded, failed: result.failed }, { sessionId: store.activeSession?.id });
        renderIntegrity(result);
        const total = result.loaded.length + result.failed.length;
        $('#runtimeBadge').classList.toggle('ready', result.failed.length === 0);
        $('#runtimeBadge').innerHTML = `<i></i> ${result.failed.length ? `${total - result.failed.length}/${total} 脚本就绪` : '玩法运行时就绪'}`;
        if (result.failed.length) toast('部分远程卡片模块未加载，请检查网络；核心内置兼容层仍可运行。', 'error');
        window.__reincarnationApp = { store, runtime, blackbox, generate, newSession, refreshPersonalShop, forgeShop: forgePersonalShop, forge_shop: forgePersonalShop, presets: () => presets, scripts: () => scripts, renderAll, renderPersonalShop, renderBlackBox, getAffection: (source, target) => getAffection(runtime.variables.stat_data, source, target) };
        await blackbox.record('lifecycle', 'boot_completed', { activeSessionId: store.activeSession?.id, activePresetId: store.data.settings.activePresetId, activeConnectionId: store.data.settings.activeConnectionId }, { sessionId: store.activeSession?.id });
        await renderBlackBox();
    } catch (error) {
        console.error(error);
        await blackbox.record('lifecycle', 'boot_failed', { error });
        toast(`启动失败：${error.message}`, 'error');
        $('#runtimeBadge').innerHTML = '<i></i> 启动失败';
    }
}

boot();
