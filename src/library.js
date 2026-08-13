const DB_NAME = 'reincarnation-library';
const DB_VERSION = 3;
const STORES = ['presets', 'scripts', 'profiles', 'userProfiles', 'regexPresets'];

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function transaction(storeName, mode, operation) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const result = operation(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(result?.result);
        tx.onerror = () => reject(tx.error);
    });
}

export const library = {
    async list(store) { return (await transaction(store, 'readonly', objectStore => objectStore.getAll())) ?? []; },
    async get(store, id) { return transaction(store, 'readonly', objectStore => objectStore.get(id)); },
    async put(store, value) { await transaction(store, 'readwrite', objectStore => objectStore.put(value)); return value; },
    async delete(store, id) { return transaction(store, 'readwrite', objectStore => objectStore.delete(id)); },
};

function activeOrder(raw) {
    const orders = raw.prompt_order ?? [];
    return orders.find(item => item.character_id === 100001)?.order ?? orders.at(-1)?.order ?? [];
}

export function normalizePreset(raw, filename = '未命名预设') {
    if (!Array.isArray(raw?.prompts)) throw new Error('不是可识别的 SillyTavern OAI/AIRP 预设：缺少 prompts');
    const order = activeOrder(raw);
    const enabledMap = new Map(order.map((item, index) => [item.identifier, { enabled: item.enabled !== false, index }]));
    const prompts = raw.prompts.map((prompt, sourceIndex) => ({
        identifier: prompt.identifier || crypto.randomUUID(),
        name: prompt.name || prompt.identifier || `条目 ${sourceIndex + 1}`,
        role: ['system', 'user', 'assistant'].includes(prompt.role) ? prompt.role : 'system',
        content: prompt.content || '',
        marker: Boolean(prompt.marker),
        enabled: enabledMap.has(prompt.identifier) ? enabledMap.get(prompt.identifier).enabled : prompt.enabled !== false,
        order: enabledMap.get(prompt.identifier)?.index ?? 10000 + sourceIndex,
        injectionPosition: prompt.injection_position ?? 0,
        injectionDepth: prompt.injection_depth ?? 4,
    })).sort((a, b) => a.order - b.order);
    return {
        id: crypto.randomUUID(),
        name: filename.replace(/\.json$/i, ''),
        format: 'sillytavern-oai',
        importedAt: new Date().toISOString(),
        prompts,
        sampling: {
            temperature: raw.temperature,
            topP: raw.top_p,
            topK: raw.top_k,
            frequencyPenalty: raw.frequency_penalty,
            presencePenalty: raw.presence_penalty,
            maxTokens: raw.openai_max_tokens,
            contextSize: raw.openai_max_context,
            reasoningEffort: raw.reasoning_effort,
        },
        assistantPrefill: raw.assistant_prefill || '',
        squashSystemMessages: Boolean(raw.squash_system_messages),
        extensions: raw.extensions || {},
        raw,
    };
}

export function normalizeScript(raw, filename = '未命名脚本') {
    if (raw?.type !== 'script' || typeof raw.content !== 'string') throw new Error('不是可识别的酒馆助手脚本');
    const { content, ...metadata } = raw;
    return { id: raw.id || crypto.randomUUID(), name: raw.name || filename.replace(/\.(?:json|m?js)$/i, ''), enabled: raw.enabled !== false, importedAt: new Date().toISOString(), content, data: raw.data || {}, button: raw.button || {}, raw: metadata };
}

export function normalizeUserProfile(raw = {}, fallbackName = '用户设定') {
    const name = String(raw.name || fallbackName).trim() || fallbackName;
    return {
        id: raw.id || crypto.randomUUID(),
        name,
        displayName: String(raw.displayName ?? raw.userName ?? '').trim(),
        persona: String(raw.persona ?? raw.content ?? '').trim(),
        description: String(raw.description ?? raw.note ?? '').trim(),
        tags: Array.isArray(raw.tags) ? raw.tags.map(item => String(item).trim()).filter(Boolean).slice(0, 20) : [],
        createdAt: raw.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

export function normalizeRegexPreset(raw, filename = '未命名正则预设') {
    const scripts = Array.isArray(raw) ? raw : raw?.scripts || raw?.regex_scripts;
    if (!Array.isArray(scripts)) throw new Error('不是可识别的酒馆正则预设：缺少脚本数组');
    return {
        id: raw?.id || crypto.randomUUID(),
        name: raw?.name || filename.replace(/\.json$/i, ''),
        enabled: raw?.enabled !== false,
        importedAt: new Date().toISOString(),
        scripts: scripts.map((script, index) => ({
            id: script.id || crypto.randomUUID(),
            scriptName: script.scriptName || script.script_name || script.name || `正则 ${index + 1}`,
            disabled: Boolean(script.disabled),
            runOnEdit: Boolean(script.runOnEdit ?? script.run_on_edit),
            findRegex: script.findRegex || script.find_regex || script.regex || '',
            replaceString: script.replaceString ?? script.replace_string ?? script.replace ?? '',
            trimStrings: script.trimStrings || script.trim_strings || [],
            placement: script.placement || [1, 2],
            substituteRegex: script.substituteRegex ?? script.substitute_regex ?? 0,
            minDepth: script.minDepth ?? script.min_depth ?? null,
            maxDepth: script.maxDepth ?? script.max_depth ?? null,
            markdownOnly: Boolean(script.markdownOnly ?? script.markdown_only),
            promptOnly: Boolean(script.promptOnly ?? script.prompt_only),
        })),
        raw,
    };
}
