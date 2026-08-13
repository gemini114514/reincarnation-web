import { DeterministicRng, deepClone, seed256 } from '../combat/util.js';

export const SHOP_RULESET_VERSION = 'shop-forge-v3.2.6';
export const QUALITY_ORDER = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
export const QUALITY_LEVEL_RANGES = {
    F: [1, 5], E: [6, 10], D: [11, 15], C: [16, 20], B: [21, 25], A: [26, 30], S: [31, 35], SS: [36, 40], SSS: [41, 50],
};

const RULES = {
    武器: { F: { 命中: [2, 2], 期望伤害: [4, 12] }, E: { 命中: [3, 4], 期望伤害: [10, 22] }, D: { 命中: [5, 7], 期望伤害: [18, 36] }, C: { 命中: [7, 9], 期望伤害: [30, 55] }, B: { 命中: [9, 11], 期望伤害: [48, 82] }, A: { 命中: [11, 13], 期望伤害: [72, 115] }, S: { 命中: [13, 15], 期望伤害: [105, 160] }, SS: { 命中: [15, 17], 期望伤害: [150, 225] }, SSS: { 命中: [17, 19], 期望伤害: [210, 320] } },
    身体防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 2], MDEF: [1, 2] }, D: { DEF: [2, 3], MDEF: [2, 3] }, C: { DEF: [3, 4], MDEF: [3, 4] }, B: { DEF: [4, 5], MDEF: [4, 5] }, A: { DEF: [5, 6], MDEF: [5, 6] }, S: { DEF: [6, 7], MDEF: [6, 7] }, SS: { DEF: [7, 8], MDEF: [7, 8] }, SSS: { DEF: [8, 9], MDEF: [8, 9] } },
    腿部防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 1], MDEF: [1, 1] }, D: { DEF: [1, 2], MDEF: [1, 2] }, C: { DEF: [2, 3], MDEF: [2, 3] }, B: { DEF: [3, 4], MDEF: [3, 4] }, A: { DEF: [4, 4], MDEF: [4, 4] }, S: { DEF: [4, 5], MDEF: [4, 5] }, SS: { DEF: [5, 6], MDEF: [5, 6] }, SSS: { DEF: [6, 7], MDEF: [6, 7] } },
    头部防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 1], MDEF: [1, 1] }, D: { DEF: [1, 2], MDEF: [1, 2] }, C: { DEF: [2, 2], MDEF: [2, 2] }, B: { DEF: [2, 3], MDEF: [2, 3] }, A: { DEF: [3, 3], MDEF: [3, 3] }, S: { DEF: [3, 4], MDEF: [3, 4] }, SS: { DEF: [4, 5], MDEF: [4, 5] }, SSS: { DEF: [4, 6], MDEF: [4, 6] } },
    盾牌防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 2], MDEF: [1, 2] }, D: { DEF: [2, 2], MDEF: [2, 2] }, C: { DEF: [2, 3], MDEF: [2, 3] }, B: { DEF: [3, 4], MDEF: [3, 4] }, A: { DEF: [4, 5], MDEF: [4, 5] }, S: { DEF: [5, 6], MDEF: [5, 6] }, SS: { DEF: [6, 7], MDEF: [6, 7] }, SSS: { DEF: [7, 8], MDEF: [7, 8] } },
    技能: { F: { 期望伤害: [7, 18], 消耗: [5, 10] }, E: { 期望伤害: [16, 34], 消耗: [10, 20] }, D: { 期望伤害: [28, 54], 消耗: [20, 40] }, C: { 期望伤害: [45, 80], 消耗: [40, 60] }, B: { 期望伤害: [70, 120], 消耗: [60, 90] }, A: { 期望伤害: [105, 165], 消耗: [90, 130] }, S: { 期望伤害: [145, 220], 消耗: [130, 200] }, SS: { 期望伤害: [205, 305], 消耗: [160, 250] }, SSS: { 期望伤害: [285, 420], 消耗: [200, 300] } },
    血统: { F: { 预算: [3, 5] }, E: { 预算: [6, 10] }, D: { 预算: [12, 20] }, C: { 预算: [21, 35] }, B: { 预算: [33, 55] }, A: { 预算: [48, 80] }, S: { 预算: [66, 110] }, SS: { 预算: [90, 150] }, SSS: { 预算: [120, 200] } },
    价格区间: { F: [100, 500], E: [500, 2000], D: [2000, 6000], C: [6000, 18000], B: [18000, 50000], A: [50000, 150000], S: [150000, 500000], SS: [500000, 1500000], SSS: [1500000, 5000000] },
};

const SLOTS = [
    { 子类型: '武器', 槽位: '武器' }, { 子类型: '防具', 槽位: '盾', 防具类型: '盾牌防具' }, { 子类型: '防具', 槽位: '铠甲', 防具类型: '身体防具' },
    { 子类型: '防具', 槽位: '头盔', 防具类型: '头部防具' }, { 子类型: '防具', 槽位: '腿甲', 防具类型: '腿部防具' },
    { 子类型: '饰品', 槽位: '腰带' }, { 子类型: '饰品', 槽位: '鞋子' }, { 子类型: '饰品', 槽位: '饰品' },
];

const CATEGORY_KEYS = { bloodline: '血统列表', skill: '技能列表', equipment: '装备列表', item: '道具列表', upgrade: '升级列表' };
const CATEGORY_ALIASES = { 血统: 'bloodline', 血统列表: 'bloodline', 技能: 'skill', 技能列表: 'skill', 装备: 'equipment', 装备列表: 'equipment', 道具: 'item', 道具列表: 'item', 升级: 'upgrade', 升级列表: 'upgrade' };

function number(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, number(value, min))); }
function unique(list) { return [...new Set((Array.isArray(list) ? list : []).map(item => String(item || '').trim()).filter(Boolean))]; }
function qualityFromLevel(level) { return QUALITY_ORDER.find(quality => level >= QUALITY_LEVEL_RANGES[quality][0] && level <= QUALITY_LEVEL_RANGES[quality][1]) || 'F'; }
function levelProgress(level) { const [lo, hi] = QUALITY_LEVEL_RANGES[qualityFromLevel(level)]; return (level - lo) / Math.max(hi - lo, 1); }
function windowRange(range, level, ratio = .4) { const span = range[1] - range[0]; const window = span < 2 ? span : Math.max(1, span * ratio); const start = range[0] + (span - window) * levelProgress(level); return [Math.max(range[0], Math.round(start)), Math.min(range[1], Math.round(start + window))]; }
function levelRule(category, level) { const quality = qualityFromLevel(level); const base = RULES[category]?.[quality]; if (!base) return null; return Object.fromEntries(Object.entries(base).map(([key, range]) => [key, windowRange(range, level, key === '预算' ? .45 : key === '消耗' ? .5 : key === '命中' ? .7 : key === 'DEF' || key === 'MDEF' ? 1 : .4)])); }
function randomInt(rng, range) { return rng.int(Math.ceil(range[0]), Math.floor(range[1])); }
function tieredPrices(rng, range, count) { const [min, max] = range; const step = (max - min) / (count + 1); return Array.from({ length: count }, (_item, index) => { const base = min + step * (index + 1); return randomInt(rng, [Math.max(min, Math.floor(base - step * .4)), Math.min(max, Math.ceil(base + step * .4))]); }); }
function itemId(prefix, rng) { return `${prefix}_${rng.nextUint32().toString(36)}_${rng.index}`; }
function diceForExpected(value) { const faces = [4, 6, 8, 10, 12, 14, 16, 18, 20]; let best = { count: 1, face: 4, score: Infinity }; for (let count = 1; count <= 12; count += 1) for (const face of faces) { const expected = count * (face + 1) / 2; const score = Math.abs(expected - value); if (score < best.score) best = { count, face, score }; } return `${best.count}d${best.face}`; }
function bloodlineStats(budget, rank) { const stats = {}; const add = (key, amount) => { stats[key] = (stats[key] || 0) + amount; }; if (rank % 4 === 0) { add('DEF加成', Math.max(1, Math.floor(budget / 18))); add('HP加成', Math.floor(Math.max(0, budget - 5) * 2)); } else if (rank % 4 === 1) { add('ATK加成', Math.max(1, Math.floor(budget / 20))); add('HP加成', Math.floor(Math.max(0, budget - 5) * 2)); } else if (rank % 4 === 2) { add('法术ATK加成', Math.max(1, Math.floor(budget / 20))); add('法术强度加成', Math.floor(Math.max(0, budget - 5) * 2)); } else { add('豁免加成', Math.max(1, Math.floor(budget / 18))); add('MP加成', Math.floor(Math.max(0, budget - 3) * 5)); } return stats; }

function normalizeTarget(target = {}) {
    const raw = Array.isArray(target.categories) && target.categories.length ? target.categories : target.category ? [target.category] : ['all'];
    const categories = raw.includes('all') ? Object.keys(CATEGORY_KEYS) : unique(raw).map(item => CATEGORY_ALIASES[item] || item).filter(item => CATEGORY_KEYS[item]);
    const slots = unique((Array.isArray(target.slotPreferences) && target.slotPreferences.length ? target.slotPreferences : target.slots)).filter(slot => ['武器', '法术武器', '铠甲', '头盔', '腿甲', '鞋子', '盾', '饰品', '腰带'].includes(slot));
    return { categories: categories.length ? categories : Object.keys(CATEGORY_KEYS), slots, count: clamp(target.count || 0, 0, 50), query: String(target.query || '').slice(0, 500) };
}

export function emptyCatalog() { return { 血统列表: [], 技能列表: [], 装备列表: [], 道具列表: [], 升级列表: [], 成员商库: {} }; }

export function normalizeCatalog(value) { const catalog = emptyCatalog(); const source = value?.商城 && typeof value.商城 === 'object' ? value.商城 : value; for (const key of Object.values(CATEGORY_KEYS)) if (Array.isArray(source?.[key])) catalog[key] = source[key].map((item, index) => normalizeItem(item, key, index)); if (source?.成员商库 && typeof source.成员商库 === 'object') catalog.成员商库 = deepClone(source.成员商库); return catalog; }

function normalizeItem(item = {}, category, index) {
    const type = category === '技能列表' ? '技能' : category === '装备列表' || category === '升级列表' ? '装备' : category === '血统列表' ? '血统' : '道具';
    return { id: String(item.id || `${category}-${index + 1}`), 类型: item.类型 || type, 等级: clamp(item.等级 || item.level || 1, 1, 50), 品质: QUALITY_ORDER.includes(item.品质) ? item.品质 : qualityFromLevel(clamp(item.等级 || 1, 1, 50)), 名称: String(item.名称 || item.name || '未命名'), 标签: unique(item.标签 || item.tags), 描述: String(item.描述 || item.desc || ''), 价格: Math.max(0, Math.round(number(item.价格 ?? item.cost, 0))), ...item };
}

function selectedCount(target, category, fallback) { return target.count > 0 && target.categories.length === 1 ? target.count : fallback; }

export function generateShopDraft({ playerLevel = 1, slotPreferences = [], target = {}, seed, hero = {}, currentCatalog = {} } = {}) {
    const level = clamp(Math.round(playerLevel), 1, 50); const normalizedTarget = normalizeTarget({ ...target, slotPreferences }); const rng = new DeterministicRng(seed256(seed || `${level}:${JSON.stringify(normalizedTarget)}`)); const catalog = normalizeCatalog(currentCatalog); const range = RULES.价格区间[qualityFromLevel(level)]; const baseRating = qualityFromLevel(level); const generated = emptyCatalog();
    const has = key => normalizedTarget.categories.includes(key);
    if (has('skill')) { const count = selectedCount(normalizedTarget, 'skill', 2 + rng.int(0, 1)); const prices = tieredPrices(rng, range, count); const rule = levelRule('技能', level); generated.技能列表 = Array.from({ length: count }, (_item, index) => ({ id: itemId('sk', rng), 类型: '技能', 技能类型分类: index % 3 ? '主动' : '被动', 等级: level, 品质: baseRating, 名称: '待定技能', 价格: prices[index], 消耗: randomInt(rng, rule.消耗), 伤害: diceForExpected(randomInt(rng, rule.期望伤害)), 标签: ['攻击'], 效果: {}, 描述: '等待 API 填充描述' })); }
    if (has('bloodline')) { const count = selectedCount(normalizedTarget, 'bloodline', 2 + rng.int(0, 1)); const prices = tieredPrices(rng, range, count); const rule = levelRule('血统', level); generated.血统列表 = Array.from({ length: count }, (_item, index) => ({ id: itemId('bl', rng), 类型: '血统', 等级: level, 品质: baseRating, 名称: '待定血统', 价格: prices[index], 原始属性: bloodlineStats(randomInt(rng, rule.预算), index), 效果: {}, 描述: '等待 API 填充描述' })); }
    if (has('equipment')) {
        for (const slot of SLOTS) { const preferred = normalizedTarget.slots.includes(slot.槽位) || slot.槽位 === '武器' && normalizedTarget.slots.includes('法术武器'); const outputSlot = slot.槽位 === '武器' && normalizedTarget.slots.includes('法术武器') && !normalizedTarget.slots.includes('武器') ? '法术武器' : slot.槽位; const count = slot.子类型 === '武器' ? (preferred ? rng.int(3, 4) : rng.int(2, 3)) : slot.子类型 === '防具' ? (preferred ? rng.int(2, 3) : rng.int(1, 2)) : (normalizedTarget.slots.length ? rng.int(0, 1) : rng.int(0, 2)); if (!count) continue; const prices = tieredPrices(rng, range, count); const rule = slot.子类型 === '武器' ? levelRule('武器', level) : levelRule(slot.防具类型 || '身体防具', level); for (let index = 0; index < count; index += 1) generated.装备列表.push({ id: itemId('eq', rng), 类型: '装备', 子类型: slot.子类型, 槽位: outputSlot, 等级: level, 品质: baseRating, 名称: '待定装备', 价格: prices[index], 原始属性: slot.子类型 === '武器' ? { 命中: randomInt(rng, rule.命中), 伤害: diceForExpected(randomInt(rng, rule.期望伤害)) } : slot.子类型 === '防具' ? { DEF: randomInt(rng, rule.DEF), MDEF: randomInt(rng, rule.MDEF) } : {}, 效果: {}, 标签: [outputSlot], 描述: '等待 API 填充描述' }); }
    }
    if (has('item')) { const count = selectedCount(normalizedTarget, 'item', 2 + rng.int(0, 1)); const prices = tieredPrices(rng, range, count); generated.道具列表 = Array.from({ length: count }, (_item, index) => ({ id: itemId('it', rng), 类型: '道具', 道具类型: '消耗品', 等级: level, 品质: baseRating, 名称: '待定道具', 价格: prices[index], 数量: 1, 标签: index % 2 ? ['潜行'] : ['脱身'], 效果: {}, 描述: '等待 API 填充描述' })); }
    if (has('upgrade')) generated.升级列表 = generateUpgrades(hero, level, range, rng);
    for (const key of Object.values(CATEGORY_KEYS)) if (normalizedTarget.categories.includes(Object.keys(CATEGORY_KEYS).find(name => CATEGORY_KEYS[name] === key))) catalog[key] = generated[key];
    return { catalog, generated, target: normalizedTarget, playerLevel: level, baseQuality: baseRating, seed: seed256(seed || `${level}:${JSON.stringify(normalizedTarget)}`), rulesetVersion: SHOP_RULESET_VERSION, rngIndex: rng.index };
}

function generateUpgrades(hero, level, range, rng) { const list = []; const add = (source, category) => { for (const [name, item] of Object.entries(source || {})) { const oldLevel = number(item?.等级, 0); if (!item || oldLevel <= 0 || oldLevel >= level) continue; const normal = tieredPrices(rng, range, 1)[0]; list.push({ id: itemId('up', rng), 类型: category, 等级: level, 品质: qualityFromLevel(level), 名称: name, 价格: Math.max(1, Math.floor(normal * .7)), 原价: normal, 升级自: name, 升级类型: category, 原等级: oldLevel, 升级优惠: '30%', 替换目标: name, 原始属性: deepClone(item.被动属性 || item.原始属性 || {}), 效果: deepClone(item.效果 || {}), 标签: unique(item.标签), 描述: `${name} 的升级版，购买后替换原条目。` }); } }; add(hero?.技能, '技能'); add(hero?.血统, '血统'); add(hero?.装备 || hero?.装备栏, '装备'); return list; }

export function mergeApiCatalog(draftCatalog, responseCatalog, target) {
    const result = normalizeCatalog(draftCatalog); const incoming = normalizeCatalog(responseCatalog); const fields = ['名称', '标签', '描述', '效果', '消耗', '道具类型'];
    for (const category of target.categories) { const key = CATEGORY_KEYS[category]; const incomingItems = Array.isArray(incoming[key]) && incoming[key].length ? incoming[key] : (draftCatalog[key] || []); result[key] = incomingItems.slice(0, draftCatalog[key]?.length || incomingItems.length || 50).map((item, index) => { const base = draftCatalog[key]?.[index] || {}; const safe = Object.fromEntries(fields.filter(field => item[field] !== undefined).map(field => [field, item[field]])); return normalizeItem({ ...base, ...safe, id: base.id || item.id }, key, index); }); }
    return result;
}

export function shopModelPrompt({ draft, target, playerLevel, characterName, query }) {
    return `你是《轮回战场》V3.2.6 的主神商城内容填充器。只补全商品的名称、标签、描述、效果和自然语言消耗说明，不得修改 id、类型、等级、品质、价格、原始属性、伤害骰、命中、防御数值。只输出 JSON 对象，键必须是 血统列表、技能列表、装备列表、道具列表、升级列表；每个数组按输入顺序返回。定向刷新目标：${JSON.stringify(target)}；玩家等级：${playerLevel}；当前人物：${characterName || '轮回者'}；额外要求：${query || '无'}。商品必须符合卡片规则、品质和槽位，不能生成超出等级的数值。\n\n待填充草案：\n${JSON.stringify(draft)}`;
}
