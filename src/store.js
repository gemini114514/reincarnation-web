const STORAGE_KEY = 'reincarnation-web:v1';
const STAT_ROOT_KEYS = ['世界', '任务', '主角', '资产', '系统状态', '关系列表', '传闻', '商城', '设置', '系统配置'];

const defaults = {
    settings: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: '',
        temperature: 0.9,
        maxTokens: 32768,
        userName: '轮回者',
        persona: '',
        activeConnectionId: null,
        activePresetId: null,
    },
    connections: [],
    activeSessionId: null,
    sessions: [],
};

function clone(value) {
    return structuredClone(value);
}

function mergeDeep(target, source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return clone(source);
    const output = target && typeof target === 'object' && !Array.isArray(target) ? clone(target) : {};
    for (const [key, value] of Object.entries(source)) output[key] = value && typeof value === 'object' && !Array.isArray(value) ? mergeDeep(output[key], value) : clone(value);
    return output;
}

function normalizeAffectionMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([name, score]) => [name, Number(score) || 0]));
}

export function normalizeRelationships(statData) {
    if (!statData || typeof statData !== 'object') return statData;
    const stat = statData;
    stat['主角'] = stat['主角'] && typeof stat['主角'] === 'object' ? stat['主角'] : {};
    stat['主角']['好感度关系'] = normalizeAffectionMap(stat['主角']['好感度关系']);
    stat['关系列表'] = stat['关系列表'] && typeof stat['关系列表'] === 'object' ? stat['关系列表'] : {};
    for (const npc of Object.values(stat['关系列表'])) {
        if (!npc || typeof npc !== 'object' || Array.isArray(npc)) continue;
        npc['好感度关系'] = normalizeAffectionMap(npc['好感度关系']);
        // 旧卡的数值好感度表示 NPC 对主角；保留旧字段，同时迁入有向关系表。
        if (!Object.hasOwn(npc['好感度关系'], '主角') && Number.isFinite(Number(npc['好感度'])) && Number(npc['好感度']) !== 0) npc['好感度关系']['主角'] = Number(npc['好感度']);
    }
    return stat;
}

export function getAffection(statData, sourceName, targetName) {
    if (!sourceName || !targetName || sourceName === targetName) return 0;
    const entity = sourceName === '主角' ? statData?.['主角'] : statData?.['关系列表']?.[sourceName];
    const mapped = entity?.['好感度关系']?.[targetName];
    if (mapped !== undefined) return Number(mapped) || 0;
    if (sourceName !== '主角' && targetName === '主角') return Number(entity?.['好感度']) || 0;
    return 0;
}

function migrateVariables(variables) {
    if (!variables || typeof variables !== 'object') return variables;
    const next = clone(variables);
    next.stat_data = next.stat_data && typeof next.stat_data === 'object' ? next.stat_data : {};
    for (const key of STAT_ROOT_KEYS) {
        if (next[key] === undefined) continue;
        next.stat_data[key] = mergeDeep(next.stat_data[key], next[key]);
        delete next[key];
    }
    normalizeRelationships(next.stat_data);
    return next;
}

export class GameStore extends EventTarget {
    constructor() {
        super();
        this.data = this.load();
    }

    load() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
            const data = {
                ...clone(defaults),
                ...saved,
                settings: { ...clone(defaults.settings), ...(saved?.settings ?? {}) },
                connections: Array.isArray(saved?.connections) ? saved.connections : [],
                sessions: Array.isArray(saved?.sessions) ? saved.sessions : [],
            };
            data.sessions = data.sessions.map(session => ({ ...session, personalShop: { selectedIds: [], customItems: [], ...(session.personalShop || {}) }, variables: migrateVariables(session.variables), variableSnapshots: (session.variableSnapshots || []).map(snapshot => ({ ...snapshot, variables: migrateVariables(snapshot.variables) })) }));
            data.settings.maxTokens = Math.max(30000, Number(data.settings.maxTokens) || 32768);
            data.connections = data.connections.map(connection => ({ ...connection, maxTokens: Math.max(30000, Number(connection.maxTokens) || 32768) }));
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            return data;
        } catch {
            return clone(defaults);
        }
    }

    save() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
        this.dispatchEvent(new Event('change'));
    }

    get activeSession() {
        return this.data.sessions.find(item => item.id === this.data.activeSessionId) ?? null;
    }

    createSession({ firstMessage = '【封面】', variables = {} } = {}) {
        const now = new Date().toISOString();
        const session = {
            id: crypto.randomUUID(),
            title: '新的轮回',
            createdAt: now,
            updatedAt: now,
            messages: firstMessage ? [{ id: crypto.randomUUID(), role: 'assistant', content: firstMessage, createdAt: now, swipes: [firstMessage], swipeIndex: 0 }] : [],
            personalShop: { selectedIds: [], customItems: [] },
            variables: migrateVariables(variables),
            variableSnapshots: [],
        };
        this.data.sessions.unshift(session);
        this.data.activeSessionId = session.id;
        this.save();
        return session;
    }

    selectSession(id) {
        if (!this.data.sessions.some(item => item.id === id)) return;
        this.data.activeSessionId = id;
        this.save();
    }

    deleteSession(id) {
        this.data.sessions = this.data.sessions.filter(item => item.id !== id);
        if (this.data.activeSessionId === id) this.data.activeSessionId = this.data.sessions[0]?.id ?? null;
        this.save();
    }

    addMessage(role, content = '') {
        const session = this.activeSession;
        if (!session) return null;
        const now = new Date().toISOString();
        const message = { id: crypto.randomUUID(), role, content, createdAt: now, swipes: [content], swipeIndex: 0 };
        session.messages.push(message);
        session.updatedAt = now;
        if (role === 'user' && session.messages.filter(item => item.role === 'user').length === 1) {
            session.title = content.replace(/\s+/g, ' ').slice(0, 24) || '新的轮回';
        }
        this.save();
        return message;
    }

    updateMessage(id, content) {
        const message = this.activeSession?.messages.find(item => item.id === id);
        if (!message) return;
        message.content = content;
        message.swipes[message.swipeIndex] = content;
        this.activeSession.updatedAt = new Date().toISOString();
        this.save();
    }

    removeFrom(id) {
        const session = this.activeSession;
        const index = session?.messages.findIndex(item => item.id === id) ?? -1;
        if (index >= 0) {
            session.messages.splice(index);
            session.variableSnapshots = session.variableSnapshots.filter(item => item.messageIndex < index);
            const last = session.variableSnapshots.at(-1);
            if (last) session.variables = clone(last.variables);
            this.save();
        }
    }

    saveVariables(variables, messageIndex) {
        const session = this.activeSession;
        if (!session) return;
        session.variables = migrateVariables(variables);
        session.variableSnapshots = session.variableSnapshots.filter(item => item.messageIndex !== messageIndex);
        session.variableSnapshots.push({ messageIndex, variables: clone(session.variables) });
        this.save();
    }

    updateSettings(values) {
        Object.assign(this.data.settings, values);
        this.save();
    }

    saveConnection(connection) {
        const value = { id: connection.id || crypto.randomUUID(), createdAt: connection.createdAt || new Date().toISOString(), ...connection, updatedAt: new Date().toISOString() };
        value.maxTokens = Math.max(30000, Number(value.maxTokens) || 32768);
        const index = this.data.connections.findIndex(item => item.id === value.id);
        if (index >= 0) this.data.connections[index] = value;
        else this.data.connections.push(value);
        this.data.settings.activeConnectionId = value.id;
        this.syncActiveConnection(value);
        this.save();
        return value;
    }

    deleteConnection(id) {
        this.data.connections = this.data.connections.filter(item => item.id !== id);
        if (this.data.settings.activeConnectionId === id) {
            this.data.settings.activeConnectionId = this.data.connections[0]?.id ?? null;
            if (this.data.connections[0]) this.syncActiveConnection(this.data.connections[0]);
        }
        this.save();
    }

    selectConnection(id) {
        const connection = this.data.connections.find(item => item.id === id);
        if (!connection) return;
        this.data.settings.activeConnectionId = id;
        this.syncActiveConnection(connection);
        this.save();
    }

    syncActiveConnection(connection) {
        Object.assign(this.data.settings, {
            baseUrl: connection.baseUrl,
            apiKey: connection.apiKey,
            model: connection.model,
            protocol: connection.protocol,
            temperature: Number(connection.temperature ?? this.data.settings.temperature),
            maxTokens: Number(connection.maxTokens ?? this.data.settings.maxTokens),
            path: connection.path,
            modelsPath: connection.modelsPath,
            apiVersion: connection.apiVersion,
            extraHeaders: connection.extraHeaders,
            extraBody: connection.extraBody,
            testPrompt: connection.testPrompt,
        });
    }

    export() {
        return JSON.stringify({ format: 'reincarnation-web-save', version: 1, exportedAt: new Date().toISOString(), data: this.data }, null, 2);
    }
}
