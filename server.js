import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCharacterCard } from './lib/card.js';
import vm from 'node:vm';
import { createCombatRouter } from './combat/router.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const cardPath = path.join(root, 'card', 'V3.2.6.png');
const app = express();
const port = Number(process.env.REINCARNATION_PORT || 4174);
const MAX_UPSTREAM_CONCURRENCY = 4;
let activeUpstreamCalls = 0;
const upstreamQueue = [];

function acquireUpstreamSlot() {
    return new Promise(resolve => {
        const enter = () => { activeUpstreamCalls += 1; resolve(); };
        if (activeUpstreamCalls < MAX_UPSTREAM_CONCURRENCY) enter();
        else upstreamQueue.push(enter);
    });
}

function releaseUpstreamSlot() {
    activeUpstreamCalls = Math.max(0, activeUpstreamCalls - 1);
    upstreamQueue.shift()?.();
}

app.use(express.json({ limit: '8mb' }));
const combat = createCombatRouter(root);
app.use('/api/combat', combat.router);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/card', (_req, res) => {
    try {
        res.json(readCharacterCard(cardPath));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/card/image', (_req, res) => res.sendFile(cardPath));

const OPENING_SOURCE = 'https://cdn.jsdelivr.net/gh/Unspoken-MomoTea/Battlefield-of-Reincarnation@2e80eb1bc1df68cda5ac3d25d41233b503990e37/dist/V20260812/%E5%BC%80%E5%B1%80.html';
let openingDataCache;

function extractObjectLiteral(source, marker) {
    const markerAt = source.indexOf(marker);
    const start = source.indexOf('{', markerAt);
    if (markerAt < 0 || start < 0) throw new Error(`远程开局缺少 ${marker}`);
    let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index], next = source[index + 1];
        if (lineComment) { if (char === '\n') lineComment = false; continue; }
        if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; } continue; }
        if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; }
        if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
        if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
        if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
        if (char === '{') depth += 1;
        if (char === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error('远程开局数据库对象不完整');
}

app.get('/api/opening-data', async (_req, res) => {
    try {
        if (!openingDataCache) {
            const response = await fetch(OPENING_SOURCE, { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            const html = await response.text();
            const raw = vm.runInNewContext(`(${extractObjectLiteral(html, 'const DB =')})`, Object.create(null), { timeout: 1000 });
            openingDataCache = JSON.parse(JSON.stringify({
                source: OPENING_SOURCE, version: 'V20260812', initSpaceCoins: raw.initSpaceCoins,
                attrBasePoints: raw.attrBasePoints, attributes: raw.attributes, equipTypes: raw.equipTypes,
                itemCategories: raw.itemCategories, rarityList: raw.rarityList, equipments: raw.equipments,
                items: raw.items, skills: raw.skills, factionInfo: raw.factionInfo,
                plotCategories: raw.plotCategories, plots: raw.plots,
            }));
        }
        res.json(openingDataCache);
    } catch (error) { res.status(502).json({ error: `加载卡片开局数据库失败：${error.message}` }); }
});

app.post('/api/import-script-url', async (req, res) => {
    try {
        const sourceUrl = new URL(String(req.body.url || '').trim());
        if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('脚本地址必须使用 http:// 或 https://');
        const upstream = await fetch(sourceUrl, { headers: { Accept: 'application/json,text/javascript,text/plain,*/*' }, signal: AbortSignal.timeout(60000) });
        if (!upstream.ok || !upstream.body) throw new Error(`远程服务器返回 ${upstream.status} ${upstream.statusText}`);
        const limit = 32 * 1024 * 1024;
        const declared = Number(upstream.headers.get('content-length') || 0);
        if (declared > limit) throw new Error('远程脚本超过 32 MB 限制');
        const chunks = []; let size = 0;
        const reader = upstream.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel(); throw new Error('远程脚本超过 32 MB 限制'); }
            chunks.push(Buffer.from(value));
        }
        const pathParts = sourceUrl.pathname.split('/').filter(Boolean).map(item => decodeURIComponent(item));
        const leaf = pathParts.at(-1) || '远程助手脚本.json';
        const filename = /^index\.(?:m?js|json)$/i.test(leaf) && pathParts.length > 1 ? `${pathParts.at(-2)}${leaf.slice(5)}` : leaf;
        res.json({ url: sourceUrl.href, filename, contentType: upstream.headers.get('content-type') || '', content: Buffer.concat(chunks).toString('utf8') });
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

function endpoint(baseUrl, suffix) {
    const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(clean)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
    return clean.endsWith('/v1') ? `${clean}${suffix}` : `${clean}/v1${suffix}`;
}

function cleanBase(baseUrl) {
    const value = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(value)) throw new Error('API 地址必须以 http:// 或 https:// 开头');
    return value;
}

function customEndpoint(baseUrl, customPath, fallback) {
    const base = cleanBase(baseUrl);
    const route = String(customPath || fallback || '').trim();
    if (/^https?:\/\//i.test(route)) return route;
    for (const prefix of ['/v1beta', '/v1']) {
        if (base.toLowerCase().endsWith(prefix) && route.toLowerCase().startsWith(`${prefix}/`)) return `${base}${route.slice(prefix.length)}`;
    }
    return `${base.replace(/\/+$/, '')}/${route.replace(/^\/+/, '')}`;
}

function jsonObject(value, label) {
    if (!value) return {};
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${label}不是有效 JSON 对象`);
    return parsed;
}

function providerHeaders(apiKey, extras = {}, base = {}) {
    const headers = { ...base, ...extras };
    if (apiKey && !Object.keys(headers).some(key => key.toLowerCase() === 'authorization') && !Object.keys(headers).some(key => key.toLowerCase() === 'x-api-key')) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
}

function systemAndMessages(messages) {
    const system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n');
    const chat = messages.filter(item => item.role !== 'system').map(item => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content }));
    return { system, chat };
}

function openAiResponsesInput(messages) {
    return messages.map(item => ({ role: item.role, content: [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.content }] }));
}

app.post('/api/models', async (req, res) => {
    try {
        const protocol = req.body.protocol || 'openai-chat';
        const base = cleanBase(req.body.baseUrl);
        const extras = jsonObject(req.body.extraHeaders, '额外请求头');
        let url;
        let headers = {};
        if (protocol === 'gemini') {
            url = customEndpoint(base, req.body.modelsPath, '/v1beta/models');
            url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(req.body.apiKey || '')}`;
            headers = extras;
        } else if (protocol === 'anthropic') {
            url = customEndpoint(base, req.body.modelsPath, '/v1/models');
            headers = { 'x-api-key': req.body.apiKey || '', 'anthropic-version': req.body.apiVersion || '2023-06-01', ...extras };
        } else {
            url = customEndpoint(base, req.body.modelsPath, '/v1/models');
            headers = providerHeaders(req.body.apiKey, extras);
        }
        const response = await fetch(url, { headers });
        const body = await response.text();
        if (!response.ok) return res.status(response.status).type('application/json').send(body);
        const parsed = JSON.parse(body);
        if (protocol === 'gemini') return res.json({ data: (parsed.models || []).filter(item => item.supportedGenerationMethods?.includes('generateContent')).map(item => ({ id: item.name.replace(/^models\//, '') })) });
        res.json(parsed);
    } catch (error) {
        res.status(502).json({ error: error.message });
    }
});

app.post('/api/chat', async (req, res) => {
    const { baseUrl, apiKey, model, messages, temperature = 0.9, maxTokens = 32768, protocol = 'openai-chat', topP, topK, frequencyPenalty, presencePenalty, reasoningEffort, assistantPrefill, stream = true } = req.body;
    const upstreamController = new AbortController();
    let upstreamTimeout;
    const armUpstreamTimeout = phase => {
        clearTimeout(upstreamTimeout);
        upstreamTimeout = setTimeout(() => upstreamController.abort(new Error(`${phase}连续 300 秒无响应`)), 300000);
    };
    res.on('close', () => { if (!res.writableEnded) upstreamController.abort(new Error('客户端已断开')); });
    await acquireUpstreamSlot();
    armUpstreamTimeout('等待上游');
    try {
        if (!model) throw new Error('请先填写模型名称');
        const base = cleanBase(baseUrl);
        const extraHeaders = jsonObject(req.body.extraHeaders, '额外请求头');
        const extraBody = jsonObject(req.body.extraBody, '额外请求体');
        if (protocol === 'anthropic') {
            const { system, chat } = systemAndMessages(messages);
            if (assistantPrefill) chat.push({ role: 'assistant', content: assistantPrefill });
            const upstream = await fetch(customEndpoint(base, req.body.path, '/v1/messages'), {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey || '', 'anthropic-version': req.body.apiVersion || '2023-06-01', ...extraHeaders },
                body: JSON.stringify({ model, system, messages: chat, temperature, top_p: topP, top_k: topK, max_tokens: maxTokens, stream: false, ...extraBody }),
                signal: upstreamController.signal,
            });
            armUpstreamTimeout('接收响应');
            const data = await upstream.json();
            if (!upstream.ok) return res.status(upstream.status).json(data);
            return res.json({ choices: [{ message: { role: 'assistant', content: (data.content || []).filter(item => item.type === 'text').map(item => item.text).join('') } }], usage: data.usage });
        }
        if (protocol === 'gemini') {
            const { system, chat } = systemAndMessages(messages);
            const contents = chat.map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] }));
            if (assistantPrefill) contents.push({ role: 'model', parts: [{ text: assistantPrefill }] });
            let route = String(req.body.path || '/v1beta/models/{model}:generateContent').replace('{model}', encodeURIComponent(model));
            const url = customEndpoint(base, route, route) + `${route.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey || '')}`;
            const upstream = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders },
                body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents, generationConfig: { temperature, topP, topK, maxOutputTokens: maxTokens }, ...extraBody }),
                signal: upstreamController.signal,
            });
            armUpstreamTimeout('接收响应');
            const data = await upstream.json();
            if (!upstream.ok) return res.status(upstream.status).json(data);
            const text = data.candidates?.[0]?.content?.parts?.map(item => item.text || '').join('') || '';
            return res.json({ choices: [{ message: { role: 'assistant', content: text } }], usage: data.usageMetadata });
        }
        if (protocol === 'openai-responses') {
            const upstream = await fetch(customEndpoint(base, req.body.path, '/v1/responses'), {
                method: 'POST', headers: providerHeaders(apiKey, extraHeaders, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({ model, input: openAiResponsesInput(messages), temperature, top_p: topP, max_output_tokens: maxTokens, ...(reasoningEffort && reasoningEffort !== 'auto' ? { reasoning: { effort: reasoningEffort } } : {}), stream: false, ...extraBody }),
                signal: upstreamController.signal,
            });
            armUpstreamTimeout('接收响应');
            const data = await upstream.json();
            if (!upstream.ok) return res.status(upstream.status).json(data);
            const text = data.output_text || (data.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
            return res.json({ choices: [{ message: { role: 'assistant', content: text } }], usage: data.usage });
        }
        const upstream = await fetch(customEndpoint(base, req.body.path, '/v1/chat/completions'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...providerHeaders(apiKey, extraHeaders),
            },
            body: JSON.stringify({ model, messages: assistantPrefill ? [...messages, { role: 'assistant', content: assistantPrefill }] : messages, temperature, top_p: topP, max_tokens: maxTokens, frequency_penalty: frequencyPenalty, presence_penalty: presencePenalty, ...(reasoningEffort && reasoningEffort !== 'auto' ? { reasoning_effort: reasoningEffort } : {}), stream, ...(stream ? { stream_options: { include_usage: true } } : {}), ...extraBody }),
            signal: upstreamController.signal,
        });
        armUpstreamTimeout('接收响应');
        if (!stream) {
            const data = await upstream.json();
            return res.status(upstream.status).json(data);
        }
        if (!upstream.ok || !upstream.body) {
            const detail = await upstream.text();
            return res.status(upstream.status || 502).json({ error: detail || upstream.statusText });
        }
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const reader = upstream.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            armUpstreamTimeout('流式传输');
            res.write(Buffer.from(value));
        }
        res.end();
    } catch (error) {
        if (!res.headersSent) res.status(502).json({ error: error.message });
        else res.end();
    } finally {
        clearTimeout(upstreamTimeout);
        releaseUpstreamSlot();
    }
});

if (!process.argv.includes('--api-only')) {
    const dist = path.join(root, 'dist');
    if (!fs.existsSync(dist)) {
        console.error('尚未构建前端，请先运行 npm run build');
        process.exit(1);
    }
    app.use(express.static(dist));
    app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(port, '127.0.0.1', () => {
    console.log(`Reincarnation Web: http://127.0.0.1:${port}`);
});
