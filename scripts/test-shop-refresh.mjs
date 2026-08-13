import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateShopDraft, mergeApiCatalog, normalizeLifeLevel } from '../shop/engine.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPort = 4186;
const mockPort = 4286;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(url) {
    for (let i = 0; i < 80; i += 1) {
        try { const response = await fetch(url); if (response.ok) return; } catch (_error) { /* starting */ }
        await wait(100);
    }
    throw new Error(`服务未在 ${url} 启动`);
}
function requestJson(server, port, pathname, body) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
            let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
        });
        request.on('error', reject); request.end(JSON.stringify(body));
    });
}

const mockRequests = [];
const mock = http.createServer((request, response) => {
    let text = ''; request.on('data', chunk => { text += chunk; }); request.on('end', () => {
        const payload = JSON.parse(text); mockRequests.push(payload);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ 刷新目标: { categories: ['equipment'], slotPreferences: ['武器'] }, 装备列表: [{ 名称: 'API 定向烈焰刃', 标签: ['API'], 描述: '由模型补全的文案', 价格: 1, 原始属性: { 命中: 999 } }] }) } }], usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 } }));
    });
});
await new Promise(resolve => mock.listen(mockPort, '127.0.0.1', resolve));
const app = spawn(process.execPath, ['server.js', '--api-only'], { cwd: root, env: { ...process.env, REINCARNATION_PORT: String(appPort) }, stdio: 'ignore' });
try {
    await waitFor(`http://127.0.0.1:${appPort}/api/health`);
    const draft = generateShopDraft({ playerLevel: 6, slotPreferences: ['武器'], target: { categories: ['equipment'] }, seed: 'test-seed' });
    assert.equal(draft.baseQuality, 'A');
    assert.ok(draft.catalog.装备列表.length >= 3);
    const merged = mergeApiCatalog(draft.catalog, { 装备列表: [{ 名称: 'API', 价格: 1, 原始属性: { 命中: 999 } }] }, draft.target);
    assert.equal(merged.装备列表[0].名称, 'API');
    assert.notEqual(merged.装备列表[0].价格, 1);
    assert.notEqual(merged.装备列表[0].命中, 999);
    const emptyMerge = mergeApiCatalog(draft.catalog, {}, draft.target);
    assert.equal(emptyMerge.装备列表.length, draft.catalog.装备列表.length);
    const flatMerge = mergeApiCatalog(draft.catalog, { 商品列表: [{ 名称: 'flat', 类型: '武器', 描述: '兼容卡片扁平商品列表', 价格: 1 }] }, draft.target);
    assert.equal(flatMerge.装备列表[0].名称, 'flat');
    assert.notEqual(flatMerge.装备列表[0].价格, 1);
    const skillDraft = generateShopDraft({ playerLevel: 3, target: { categories: ['skill'] }, seed: 'numeric-lock' });
    const originalConsume = skillDraft.catalog.技能列表[0].消耗;
    const locked = mergeApiCatalog(skillDraft.catalog, { 技能列表: [{ 名称: '文案', 消耗: 999, 伤害: '999d20', 价格: 1 }] }, skillDraft.target);
    assert.equal(locked.技能列表[0].消耗, originalConsume);
    assert.notEqual(locked.技能列表[0].价格, 1);

    const response = await requestJson(null, appPort, '/api/shop/refresh', {
        characterName: '测试轮回者', playerLifeLevel: 'Ⅲ', playerLevel: 3, seed: 'api-seed', slotPreferences: ['武器'], target: { categories: ['equipment'] },
        currentCatalog: { 技能列表: [{ id: 'old-skill', 名称: '保留技能', 等级: 1, 品质: 'F', 价格: 100 }] },
        connection: { baseUrl: `http://127.0.0.1:${mockPort}`, path: '/v1/chat/completions', protocol: 'openai-chat', model: 'mock', apiKey: 'secret', maxTokens: 1 },
        preset: { prompts: [{ role: 'system', content: '风格测试' }] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.source, 'api');
    assert.equal(response.body.catalog.装备列表[0].名称, 'API 定向烈焰刃');
    assert.notEqual(response.body.catalog.装备列表[0].价格, 1);
    assert.equal(response.body.catalog.技能列表[0].名称, '保留技能');
    assert.ok(response.body.catalog.成员商库['测试轮回者']);
    assert.ok(mockRequests[0].max_tokens >= 30000);

    const auto = await requestJson(null, appPort, '/api/shop/refresh', { characterName: '模型决策', playerLifeLevel: 'Ⅲ', seed: 'auto-seed', target: { autonomous: true, categories: ['all'], query: '只要近战武器' }, connection: { baseUrl: `http://127.0.0.1:${mockPort}`, path: '/v1/chat/completions', protocol: 'openai-chat', model: 'mock', apiKey: 'secret' } });
    assert.equal(auto.status, 200);
    assert.equal(auto.body.source, 'api');
    assert.deepEqual(auto.body.target.categories, ['equipment']);
    assert.ok(auto.body.catalog.装备列表.length > 0);
    assert.equal(auto.body.catalog.技能列表.length, 0);

    const slotsAlias = await requestJson(null, appPort, '/api/shop/refresh', { characterName: '槽位别名', playerLifeLevel: 'Ⅲ', seed: 'slots-alias', target: { categories: ['equipment'], slots: ['盾'] } });
    assert.equal(slotsAlias.status, 200);
    assert.ok(slotsAlias.body.target.slots.includes('盾'));

    const local = await requestJson(null, appPort, '/api/shop/refresh', { characterName: '本地', playerLevel: 1, seed: 'local-seed', target: { categories: ['skill'] } });
    assert.equal(local.status, 200);
    assert.equal(local.body.source, 'local');
    assert.ok(local.body.catalog.技能列表.length >= 2);
    assert.deepEqual(local.body.priceRange, [10, 99]);

    // Card source of truth: life levels are exactly Ⅰ–Ⅸ and map one-to-one
    // to F–SSS; the price bands are the embedded character-book values.
    assert.equal(normalizeLifeLevel('Ⅰ'), 1);
    assert.equal(normalizeLifeLevel('III'), 3);
    assert.equal(normalizeLifeLevel('9'), 9);
    const levelOne = generateShopDraft({ playerLevel: 1, target: { categories: ['all'] }, seed: 'calibration-level-1' });
    assert.equal(levelOne.baseQuality, 'F');
    assert.deepEqual(levelOne.priceRange, [10, 99]);
    for (const key of ['血统列表', '技能列表', '装备列表', '道具列表']) for (const item of levelOne.catalog[key]) assert.equal(item.品质, 'F');
    const levelThree = generateShopDraft({ playerLevel: 'Ⅲ', target: { categories: ['all'] }, seed: 'calibration-level-3' });
    assert.equal(levelThree.baseQuality, 'D');
    assert.deepEqual(levelThree.priceRange, [1000, 4999]);
    for (const key of ['血统列表', '技能列表', '装备列表', '道具列表']) for (const item of levelThree.catalog[key]) assert.equal(item.品质, 'D');

    const forge = await requestJson(null, appPort, '/api/shop/forge', { characterName: '脚本调用', args: { 生命层级: 'Ⅸ', 槽位偏好: ['武器'], 生成: '商店', NPC: [] } });
    assert.equal(forge.status, 200);
    assert.equal(forge.body.tool, 'forge_shop');
    assert.equal(forge.body.baseQuality, 'SSS');
    assert.equal(forge.body.playerLevel, 9);
    assert.ok(forge.body.catalog.装备列表.length > 0);
    assert.ok(Array.isArray(forge.body.商品列表));
    assert.ok(forge.body.商品列表.length >= forge.body.catalog.装备列表.length);
    console.log('shop refresh tests passed');
} finally {
    app.kill();
    await new Promise(resolve => mock.close(resolve));
}
