import ejs from 'ejs';
import lodashDefault, * as lodashModule from 'lodash-es';
import YAML from 'yaml';
import { z } from 'zod';
import { normalizeRelationships } from './store.js';

const clone = value => structuredClone(value ?? {});
const lodash = lodashDefault ?? lodashModule;

function parseRegex(source) {
    if (!source) return null;
    if (source.startsWith('/')) {
        const end = source.lastIndexOf('/');
        if (end > 0) {
            try { return new RegExp(source.slice(1, end), source.slice(end + 1)); } catch { return null; }
        }
    }
    try { return new RegExp(source, 'g'); } catch { return null; }
}

function pointerParts(pointer) {
    return String(pointer || '').split('/').slice(1).map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getParent(root, pointer) {
    const parts = pointerParts(pointer);
    const key = parts.pop();
    let parent = root;
    for (const part of parts) {
        if (parent?.[part] === undefined) parent[part] = {};
        parent = parent[part];
    }
    return { parent, key };
}

export class CardRuntime extends EventTarget {
    constructor(cardEnvelope, store) {
        super();
        this.envelope = cardEnvelope;
        this.card = cardEnvelope.data ?? cardEnvelope;
        this.store = store;
        this.schema = null;
        this.loadedScripts = [];
        this.failedScripts = [];
        this.activePreset = null;
        this.externalRegexPresets = [];
        this.promptVariables = {};
        this.externalPrompts = new Map();
        this.events = new Map();
        this.installGlobals();
    }

    setPreset(preset) {
        this.activePreset = preset || null;
    }

    setRegexPresets(presets = []) {
        this.externalRegexPresets = presets.filter(item => item?.enabled !== false);
    }

    injectPrompts(prompts = []) {
        const list = Array.isArray(prompts) ? prompts : [prompts];
        const ids = [];
        for (const prompt of list) {
            if (!prompt) continue;
            const id = String(prompt.id || prompt.identifier || crypto.randomUUID());
            ids.push(id);
            if (prompt.content === null || prompt.content === undefined || prompt.content === '') this.externalPrompts.delete(id);
            else this.externalPrompts.set(id, { id, role: 'system', position: 'in_chat', depth: 0, ...prompt });
        }
        return { uninject: () => ids.forEach(id => this.externalPrompts.delete(id)) };
    }

    get variables() {
        return this.store.activeSession?.variables ?? {};
    }

    createInitialVariables() {
        const entry = this.card.character_book?.entries?.find(item => /\[InitVar\]/i.test(item.comment || ''));
        try { return { stat_data: YAML.parse(entry?.content || '{}') ?? {} }; } catch { return { stat_data: {} }; }
    }

    on(name, callback) {
        if (!this.events.has(name)) this.events.set(name, new Set());
        this.events.get(name).add(callback);
        return () => this.events.get(name)?.delete(callback);
    }

    async emit(name, ...args) {
        for (const callback of this.events.get(name) ?? []) {
            try { await callback(...args); } catch (error) { console.error(`[runtime:${name}]`, error); }
        }
    }

    installGlobals() {
        const runtime = this;
        window._ = lodash;
        window.z = z;
        window.GS_PARENT = window;
        window.$ = callback => {
            if (typeof callback !== 'function') {
                const nodes = callback instanceof Node || callback === window
                    ? [callback]
                    : [...document.querySelectorAll(String(callback))];
                return {
                    nodes,
                    length: nodes.length,
                    remove() { nodes.forEach(node => node.remove()); return this; },
                    append(content) { nodes.forEach(node => node.insertAdjacentHTML('beforeend', String(content))); return this; },
                    on(name, listener) { nodes.forEach(node => node.addEventListener(name, listener)); return this; },
                    off(name, listener) { nodes.forEach(node => node.removeEventListener(name, listener)); return this; },
                    addClass(name) { nodes.forEach(node => node.classList.add(name)); return this; },
                    removeClass(name) { nodes.forEach(node => node.classList.remove(name)); return this; },
                    first() { return window.$(nodes[0]); },
                    get(index) { return nodes[index]; },
                };
            }
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback, { once: true });
            else queueMicrotask(callback);
        };
        window.getMessageVar = function (path, options = {}) {
            const value = lodash.get(runtime.variables, path);
            return value === undefined ? clone(options.defaults) : value;
        };
        window.setMessageVar = async function (path, value) {
            const variables = clone(runtime.variables);
            lodash.set(variables, path, value);
            await runtime.replaceVariables(variables);
        };
        window.getVariables = () => clone(runtime.variables);
        window.updateVariablesWith = async callback => {
            const variables = clone(runtime.variables);
            const result = await callback(variables);
            await runtime.replaceVariables(result ?? variables);
        };
        window.eventOn = (name, callback) => runtime.on(name, callback);
        window.eventEmit = (name, ...args) => runtime.emit(name, ...args);
        window.waitGlobalInitialized = async name => window[name];
        window.initializeGlobal = (name, value) => { window[name] = value; };
        window.toastr = {
            success: message => runtime.notify(message, 'success'),
            error: message => runtime.notify(message, 'error'),
            warning: message => runtime.notify(message, 'warning'),
            info: message => runtime.notify(message, 'info'),
        };
        window.registerMvuSchema = schema => { runtime.schema = schema; };
        window.Mvu = {
            events: {
                VARIABLE_INITIALIZED: 'mag_variable_initiailized',
                VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
                COMMAND_PARSED: 'mag_command_parsed',
                VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
                BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
            },
            getMvuData: () => clone(runtime.variables),
            replaceMvuData: async value => runtime.replaceVariables(value),
            parseMessage: async (message, oldData) => runtime.parseVariableUpdate(message, oldData),
        };
        window.TavernHelper = {
            getChatMessages: (...args) => window.getChatMessages(...args),
            triggerSlash: command => window.triggerSlash(command),
            getVariables: window.getVariables,
            updateVariablesWith: window.updateVariablesWith,
            Mvu: window.Mvu,
        };
        const eventTypes = {
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_SENT: 'message_sent',
            CHAT_CHANGED: 'chat_changed',
        };
        window.tavern_events = { ...eventTypes, CHAT_LOADED: 'chatLoaded', APP_READY: 'app_ready' };
        window.chat_metadata = { integrity: true, variables: runtime.variables };
        window.chat = runtime.store.activeSession?.messages ?? [];
        window.SillyTavern = {
            chat: window.chat,
            getCurrentChatId: () => runtime.store.activeSession?.id || '',
            getCurrentMessageId: () => Math.max(0, (runtime.store.activeSession?.messages.length ?? 1) - 1),
            getContext: () => ({
                eventTypes,
                eventSource: {
                    on: (name, callback) => runtime.on(name, callback),
                    once: (name, callback) => {
                        const off = runtime.on(name, (...args) => { off(); callback(...args); });
                    },
                    emit: (name, ...args) => runtime.emit(name, ...args),
                },
                chat: runtime.store.activeSession?.messages ?? [],
                characterId: 0,
                name1: runtime.store.data.settings.userName,
                name2: runtime.card.name,
            }),
        };
    }

    notify(message, type = 'info') {
        this.dispatchEvent(new CustomEvent('notify', { detail: { message: String(message), type } }));
    }

    async initializeScripts() {
        const scripts = this.card.extensions?.tavern_helper?.scripts ?? [];
        for (const script of scripts) {
            if (script.enabled === false) continue;
            try {
                if (script.name === 'MVU脚本') {
                    this.loadedScripts.push({ name: script.name, mode: '内置兼容引擎' });
                    continue;
                }
                let content = script.content;
                content = content.replace(
                    /import\s*\{\s*registerMvuSchema\s*\}\s*from\s*['"][^'"]+['"];?/,
                    'const registerMvuSchema = window.registerMvuSchema;',
                );
                const importOnly = content.match(/^\s*import\s*['"]([^'"]+)['"];?\s*$/);
                if (importOnly) {
                    if (script.name === '悬浮球状态栏') {
                        this.loadedScripts.push({ name: script.name, mode: '已映射为原生状态与 HUD 页面' });
                        continue;
                    }
                    try {
                        await import(/* @vite-ignore */ importOnly[1]);
                        this.loadedScripts.push({ name: script.name, mode: '原始远程模块' });
                    } catch (error) {
                        if (script.name === '悬浮球状态栏') {
                            this.loadedScripts.push({ name: script.name, mode: '内置状态面板兼容（CDN 离线）' });
                            console.warn('悬浮球远程模块不可用，已启用内置状态面板', error);
                        } else {
                            this.failedScripts.push({ name: script.name, error: error.message });
                        }
                    }
                    continue;
                }
                const blob = new Blob([content], { type: 'text/javascript' });
                const url = URL.createObjectURL(blob);
                await import(/* @vite-ignore */ url);
                URL.revokeObjectURL(url);
                this.loadedScripts.push({ name: script.name, mode: '卡内原始脚本' });
            } catch (error) {
                this.failedScripts.push({ name: script.name, error: error.message });
                console.error(`脚本 ${script.name} 加载失败`, error);
            }
        }
        await this.emit(window.Mvu.events.VARIABLE_INITIALIZED, clone(this.variables), 0);
        return { loaded: this.loadedScripts, failed: this.failedScripts };
    }

    async validateVariables(variables) {
        if (!this.schema) { normalizeRelationships(variables.stat_data); return variables; }
        try {
            const schema = typeof this.schema === 'function' ? this.schema() : this.schema;
            const statData = await schema.parseAsync(variables.stat_data ?? {});
            const merged = { ...(variables.stat_data ?? {}), ...statData };
            const source = variables.stat_data ?? {};
            merged['主角'] = { ...(merged['主角'] || {}), '好感度关系': clone(source['主角']?.['好感度关系'] || {}) };
            merged['关系列表'] = merged['关系列表'] || {};
            for (const [name, npc] of Object.entries(source['关系列表'] || {})) {
                if (!merged['关系列表'][name]) continue;
                merged['关系列表'][name]['好感度关系'] = clone(npc?.['好感度关系'] || {});
            }
            normalizeRelationships(merged);
            return { ...variables, stat_data: merged };
        } catch (error) {
            console.warn('ZOD 校验保留原值：', error);
            normalizeRelationships(variables.stat_data);
            return variables;
        }
    }

    async replaceVariables(next) {
        const before = clone(this.variables);
        let variables = await this.validateVariables(clone(next));
        await this.emit(window.Mvu.events.VARIABLE_UPDATE_STARTED, variables);
        await this.emit(window.Mvu.events.VARIABLE_UPDATE_ENDED, variables, before);
        variables = clone(variables);
        const messageIndex = Math.max(0, (this.store.activeSession?.messages.length ?? 1) - 1);
        this.store.saveVariables(variables, messageIndex);
        this.dispatchEvent(new CustomEvent('variables', { detail: variables }));
        return variables;
    }

    async parseVariableUpdate(content, oldData = this.variables) {
        const match = String(content).match(/<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/i);
        if (!match) return clone(oldData);
        let operations;
        try { operations = JSON.parse(match[1]); } catch (error) {
            this.notify(`变量 JSON Patch 解析失败：${error.message}`, 'error');
            return clone(oldData);
        }
        const result = clone(oldData);
        if (!result.stat_data || typeof result.stat_data !== 'object') result.stat_data = {};
        const patchRoot = result.stat_data;
        for (const operation of operations) {
            try {
                const normalizedPath = String(operation.path || '').replace(/^\/stat_data(?=\/|$)/, '') || '/';
                const { parent, key } = getParent(patchRoot, normalizedPath);
                if (operation.op === 'replace') parent[key] = clone(operation.value);
                else if (operation.op === 'delta') parent[key] = Number(parent[key] || 0) + Number(operation.value || 0);
                else if (operation.op === 'insert') {
                    if (Array.isArray(parent) && key === '-') parent.push(clone(operation.value));
                    else parent[key] = clone(operation.value);
                } else if (operation.op === 'remove') {
                    if (Array.isArray(parent)) parent.splice(Number(key), 1);
                    else delete parent[key];
                } else if (operation.op === 'move') {
                    const normalizedFrom = String(operation.from || '').replace(/^\/stat_data(?=\/|$)/, '') || '/';
                    const source = getParent(patchRoot, normalizedFrom);
                    const value = clone(source.parent[source.key]);
                    if (Array.isArray(source.parent)) source.parent.splice(Number(source.key), 1);
                    else delete source.parent[source.key];
                    const normalizedTo = String(operation.to || normalizedPath).replace(/^\/stat_data(?=\/|$)/, '') || '/';
                    const target = getParent(patchRoot, normalizedTo);
                    target.parent[target.key] = value;
                }
            } catch (error) { console.warn('忽略无效变量操作', operation, error); }
        }
        await this.emit(window.Mvu.events.COMMAND_PARSED, result, operations, content);
        return result;
    }

    macros(text) {
        const settings = this.store.data.settings;
        return String(text ?? '')
            .replace(/{{\/\/[\s\S]*?}}/g, '')
            .replace(/{{setvar::([^:}]+)::([^}]*)}}/gi, (_all, key, value) => { this.promptVariables[key.trim()] = value; return ''; })
            .replace(/{{getvar::([^}]+)}}/gi, (_all, key) => String(this.promptVariables[key.trim()] ?? ''))
            .replace(/{{user}}/gi, settings.userName || '轮回者')
            .replace(/{{char}}/gi, this.card.name)
            .replace(/{{get_message_variable::([^}]+)}}/gi, (_all, path) => {
                const value = lodash.get(this.variables, path.trim());
                return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
            })
            .replace(/{{random::([^}]+)}}/gi, (_all, choices) => {
                const values = choices.split('::');
                return values[Math.floor(Math.random() * values.length)] ?? '';
            })
            .replace(/{{roll::(\d+)}}/gi, (_all, sides) => String(1 + Math.floor(Math.random() * Number(sides))))
            .replace(/{{roll}}/gi, () => String(1 + Math.floor(Math.random() * 100)));
    }

    renderTemplate(text) {
        try {
            const output = ejs.render(String(text ?? ''), {
                _: lodash,
                getMessageVar: window.getMessageVar,
                getVariables: window.getVariables,
                user: this.store.data.settings.userName,
                char: this.card.name,
            }, { async: false });
            return this.macros(output);
        } catch (error) {
            console.warn('世界书 EJS 条目执行失败，保留静态部分', error);
            return this.macros(String(text ?? '').replace(/<%[\s\S]*?%>/g, ''));
        }
    }

    activeWorldbook(messages) {
        const entries = this.card.character_book?.entries ?? [];
        const scanText = messages.slice(-12).map(item => item.content).join('\n').toLowerCase();
        return entries.filter(entry => {
            if (entry.enabled === false) return false;
            if (entry.constant) return true;
            const keys = entry.keys ?? [];
            if (!keys.length) return false;
            return keys.some(key => {
                try { return entry.use_regex ? new RegExp(key, 'i').test(scanText) : scanText.includes(String(key).toLowerCase()); }
                catch { return scanText.includes(String(key).toLowerCase()); }
            });
        }).sort((a, b) => (a.insertion_order ?? 0) - (b.insertion_order ?? 0));
    }

    buildPrompt(messages) {
        const active = this.activeWorldbook(messages);
        const before = active.filter(item => item.position === 'before_char').map(item => this.renderTemplate(item.content)).filter(Boolean);
        const after = active.filter(item => item.position !== 'before_char').map(item => this.renderTemplate(item.content)).filter(Boolean);
        const persona = this.store.data.settings.persona?.trim();
        const cardSystem = [
            '你是《轮回战场》的世界叙事与规则引擎。严格执行下列角色卡世界书、战斗、判定、实体和变量更新协议。',
            `【实体互相好感度扩展协议】
主角与每个关系列表实体都拥有“好感度关系”映射，用于记录来源实体对目标实体的有向好感度，方向不可颠倒。
路径为 /主角/好感度关系/{NPC名}、/关系列表/{NPC名}/好感度关系/主角、或 /关系列表/{NPC-A}/好感度关系/{NPC-B}。
映射允许为空；任何缺失目标一律视为0，不得仅为补零而创建字段。发生关系变化时只对对应方向增量更新。
为兼容角色卡旧规则，NPC对主角的“好感度”数值与其“好感度关系.主角”必须保持同步；其他实体间关系只写入“好感度关系”。`,
            ...before,
            this.card.description,
            this.card.personality,
            this.card.scenario,
            ...after,
            persona ? `<玩家设定>\n${persona}\n</玩家设定>` : '',
            this.card.system_prompt,
            this.card.post_history_instructions,
        ].filter(Boolean).join('\n\n');
        const visibleHistory = messages.filter(item => !item.isHidden);
        const history = visibleHistory.map((item, index) => ({
            role: item.role === 'assistant' ? 'assistant' : 'user',
            content: this.applyPromptRegex(this.macros(item.content), item.role, visibleHistory.length - 1 - index),
        }));
        const presetPrompts = (this.activePreset?.prompts ?? []).filter(item => item.enabled && !item.marker && item.content?.trim());
        const presetBefore = [];
        const depthPrompts = [];
        for (const prompt of presetPrompts) {
            const value = { role: prompt.role || 'system', content: this.macros(prompt.content) };
            if (prompt.injectionPosition === 1 && prompt.injectionDepth > 0) depthPrompts.push({ ...value, depth: prompt.injectionDepth });
            else presetBefore.push(value);
        }
        const systemPreset = presetBefore.filter(item => item.role === 'system').map(item => item.content).join('\n\n');
        const nonSystem = presetBefore.filter(item => item.role !== 'system');
        for (const prompt of this.externalPrompts.values()) {
            const value = { role: prompt.role || 'system', content: this.macros(prompt.content) };
            const depth = Number(prompt.depth ?? prompt.injectionDepth ?? 0);
            if (depth > 0 || prompt.position === 'in_chat') depthPrompts.push({ ...value, depth });
            else if (value.role === 'system') nonSystem.unshift(value);
            else nonSystem.push(value);
        }
        let outputHistory = [...history];
        for (const prompt of depthPrompts.sort((a, b) => b.depth - a.depth)) {
            const index = Math.max(0, outputHistory.length - prompt.depth);
            outputHistory.splice(index, 0, { role: prompt.role, content: prompt.content });
        }
        const system = this.activePreset?.squashSystemMessages
            ? [systemPreset, cardSystem].filter(Boolean).join('\n\n')
            : [systemPreset, cardSystem].filter(Boolean).join('\n\n');
        return { messages: [{ role: 'system', content: system }, ...nonSystem, ...outputHistory], activeEntries: active, preset: this.activePreset };
    }

    applyPromptRegex(content, role, depth = 0) {
        return this.applyRegex(content, role, 'prompt', depth);
    }

    applyDisplayRegex(content, role, depth = 0) {
        return this.applyRegex(content, role, 'display', depth);
    }

    applyExternalDisplayRegex(content, role, depth = 0) {
        return this.applyRegex(content, role, 'display', depth, this.externalRegexPresets.flatMap(preset => preset.scripts || []));
    }

    regexScripts() {
        return [...(this.card.extensions?.regex_scripts ?? []), ...this.externalRegexPresets.flatMap(preset => preset.scripts || [])];
    }

    applyRegex(content, role, mode, depth = 0, scripts = this.regexScripts()) {
        const placement = role === 'user' ? 1 : 2;
        let output = String(content ?? '');
        for (const script of scripts) {
            if (script.disabled || !(script.placement ?? []).includes(placement)) continue;
            if (script.minDepth != null && depth < Number(script.minDepth)) continue;
            if (script.maxDepth != null && depth > Number(script.maxDepth)) continue;
            if (mode === 'prompt' && script.markdownOnly) continue;
            if (mode === 'display' && script.promptOnly) continue;
            for (const trim of script.trimStrings || []) output = output.split(this.macros(trim)).join('');
            const findSource = Number(script.substituteRegex || 0) > 0 ? this.macros(script.findRegex) : script.findRegex;
            const regex = parseRegex(findSource);
            if (!regex) continue;
            try { output = output.replace(regex, this.macros(script.replaceString ?? '')); }
            catch (error) { console.warn(`正则 ${script.scriptName} 执行失败`, error); }
        }
        return output;
    }
}
