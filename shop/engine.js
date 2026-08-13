import { DeterministicRng, deepClone, seed256 } from '../combat/util.js';

// This module is a server-safe port of the embedded V3.2.6 card rules.
// The card has nine life tiers (Roman Ⅰ–Ⅸ), not a 1–50 player-level scale.
export const SHOP_RULESET_VERSION = 'v3.2.6-card-life-tier-ix';
export const QUALITY_ORDER = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
export const LIFE_LEVEL_ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ'];
export const LIFE_LEVEL_TO_QUALITY = Object.fromEntries(LIFE_LEVEL_ROMAN.map((roman, index) => [roman, QUALITY_ORDER[index]]));
export const QUALITY_LEVEL_RANGES = Object.fromEntries(QUALITY_ORDER.map((quality, index) => [quality, [index + 1, index + 1]]));
const RULES = {
    武器: { F: { 命中: [2, 2], 期望伤害: [4, 12] }, E: { 命中: [3, 4], 期望伤害: [10, 22] }, D: { 命中: [5, 7], 期望伤害: [18, 36] }, C: { 命中: [7, 9], 期望伤害: [30, 55] }, B: { 命中: [9, 11], 期望伤害: [48, 82] }, A: { 命中: [11, 13], 期望伤害: [72, 115] }, S: { 命中: [13, 15], 期望伤害: [105, 160] }, SS: { 命中: [15, 17], 期望伤害: [150, 225] }, SSS: { 命中: [17, 19], 期望伤害: [210, 320] } },
    身体防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 2], MDEF: [1, 2] }, D: { DEF: [2, 3], MDEF: [2, 3] }, C: { DEF: [3, 4], MDEF: [3, 4] }, B: { DEF: [4, 5], MDEF: [4, 5] }, A: { DEF: [5, 6], MDEF: [5, 6] }, S: { DEF: [6, 7], MDEF: [6, 7] }, SS: { DEF: [7, 8], MDEF: [7, 8] }, SSS: { DEF: [8, 9], MDEF: [8, 9] } },
    腿部防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 1], MDEF: [1, 1] }, D: { DEF: [1, 2], MDEF: [1, 2] }, C: { DEF: [2, 3], MDEF: [2, 3] }, B: { DEF: [3, 4], MDEF: [3, 4] }, A: { DEF: [4, 4], MDEF: [4, 4] }, S: { DEF: [4, 5], MDEF: [4, 5] }, SS: { DEF: [5, 6], MDEF: [5, 6] }, SSS: { DEF: [6, 7], MDEF: [6, 7] } },
    头部防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 1], MDEF: [1, 1] }, D: { DEF: [1, 2], MDEF: [1, 2] }, C: { DEF: [2, 2], MDEF: [2, 2] }, B: { DEF: [2, 3], MDEF: [2, 3] }, A: { DEF: [3, 3], MDEF: [3, 3] }, S: { DEF: [3, 4], MDEF: [3, 4] }, SS: { DEF: [4, 5], MDEF: [4, 5] }, SSS: { DEF: [4, 6], MDEF: [4, 6] } },
    盾牌防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 2], MDEF: [1, 2] }, D: { DEF: [2, 2], MDEF: [2, 2] }, C: { DEF: [2, 3], MDEF: [2, 3] }, B: { DEF: [3, 4], MDEF: [3, 4] }, A: { DEF: [4, 5], MDEF: [4, 5] }, S: { DEF: [5, 6], MDEF: [5, 6] }, SS: { DEF: [6, 7], MDEF: [6, 7] }, SSS: { DEF: [7, 8], MDEF: [7, 8] } },
    技能: { F: { 期望伤害: [7, 18], 消耗: [5, 10] }, E: { 期望伤害: [16, 34], 消耗: [10, 20] }, D: { 期望伤害: [28, 54], 消耗: [20, 40] }, C: { 期望伤害: [45, 80], 消耗: [40, 60] }, B: { 期望伤害: [70, 120], 消耗: [60, 90] }, A: { 期望伤害: [105, 165], 消耗: [90, 130] }, S: { 期望伤害: [145, 220], 消耗: [130, 200] }, SS: { 期望伤害: [205, 305], 消耗: [160, 250] }, SSS: { 期望伤害: [285, 420], 消耗: [200, 300] } },
    血统: { F: { 预算: [3, 5], 增益上限: 1, 附赠技能品质: null }, E: { 预算: [6, 10], 增益上限: 1, 附赠技能品质: null }, D: { 预算: [12, 20], 增益上限: 1, 附赠技能品质: null }, C: { 预算: [21, 35], 增益上限: 2, 附赠技能品质: 'F' }, B: { 预算: [33, 55], 增益上限: 2, 附赠技能品质: 'E' }, A: { 预算: [48, 80], 增益上限: 3, 附赠技能品质: 'D' }, S: { 预算: [66, 110], 增益上限: 3, 附赠技能品质: 'C' }, SS: { 预算: [90, 150], 增益上限: 4, 附赠技能品质: 'B' }, SSS: { 预算: [120, 200], 增益上限: 4, 附赠技能品质: 'A' } },
    // Embedded character-book entry 40: exact shop price bands.
    价格区间: { F: [10, 99], E: [100, 999], D: [1000, 4999], C: [5000, 19999], B: [20000, 79999], A: [80000, 319999], S: [320000, 1270000], SS: [1280000, 5110000], SSS: [5120000, Infinity] },
};
const SLOT_TABLE = [{ 子类型: '武器', 槽位: '武器' }, { 子类型: '防具', 槽位: '盾', 防具类型: '盾牌防具' }, { 子类型: '防具', 槽位: '铠甲', 防具类型: '身体防具' }, { 子类型: '防具', 槽位: '头盔', 防具类型: '头部防具' }, { 子类型: '防具', 槽位: '腿甲', 防具类型: '腿部防具' }, { 子类型: '饰品', 槽位: '腰带' }, { 子类型: '饰品', 槽位: '鞋子' }, { 子类型: '饰品', 槽位: '饰品' }];
const CATEGORY_KEYS = { bloodline: '血统列表', skill: '技能列表', equipment: '装备列表', item: '道具列表', upgrade: '升级列表' };
const CATEGORY_ALIASES = { 血统: 'bloodline', 血统列表: 'bloodline', 技能: 'skill', 技能列表: 'skill', 装备: 'equipment', 装备列表: 'equipment', 道具: 'item', 道具列表: 'item', 升级: 'upgrade', 升级列表: 'upgrade' };
const VALID_SLOTS = ['武器', '法术武器', '铠甲', '头盔', '腿甲', '鞋子', '盾', '饰品', '腰带'];
const WEAPON_PROFILES = [{ min: 'F', type: '剑/刀/斧/锤/枪/拳套', mode: '近战' }, { min: 'F', type: '飞刀/飞镖/短弓/投石索', mode: '投掷' }, { min: 'F', type: '旧式手枪/袖珍枪/粗制火铳', mode: '低威力远程' }, { min: 'E', type: '长弓/手弩/火铳/左轮手枪', mode: '远程' }, { min: 'D', type: '强弩/步枪/霰弹枪/符枪/飞剑匣', mode: '远程' }, { min: 'C', type: '狙击枪/重弩/榴弹发射器', mode: '压制' }, { min: 'B', type: '电磁步枪/等离子枪/浮游刃群', mode: '科技武装' }, { min: 'A', type: '因果线枪/空间折叠炮/梦境武器', mode: '概念武装' }];
const ARTIFACT_PROFILES = [{ min: 'F', type: '符箓/铃/镜/珠', mode: '短法术' }, { min: 'E', type: '法杖/法书/阵盘', mode: '法术' }, { min: 'D', type: '剑匣/灵装/魔导器', mode: '术具' }, { min: 'C', type: '高阶阵盘/灵能炮杖', mode: '术式' }, { min: 'B', type: '星轨权杖/虚数终端', mode: '科技法术' }, { min: 'A', type: '因果书页/空间权杖', mode: '概念术具' }];

const ASCII_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
const romanToLifeNumber = new Map([...LIFE_LEVEL_ROMAN.map((value, index) => [value, index + 1]), ...ASCII_ROMAN.map((value, index) => [value, index + 1])]);
export function normalizeLifeLevel(value, fallback = 1) {
    const text = String(value ?? '').trim().toUpperCase();
    if (romanToLifeNumber.has(text)) return romanToLifeNumber.get(text);
    const numeric = Number(text);
    return Number.isFinite(numeric) && numeric >= 1 ? Math.min(9, Math.round(numeric)) : fallback;
}
export function lifeLevelRoman(value) { return LIFE_LEVEL_ROMAN[normalizeLifeLevel(value) - 1] || LIFE_LEVEL_ROMAN[0]; }
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const unique = value => [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean))];
const qualityFromLevel = level => QUALITY_ORDER[normalizeLifeLevel(level) - 1] || QUALITY_ORDER[0];
const progress = level => { const q = qualityFromLevel(level); if (!q) return 0; const [lo, hi] = QUALITY_LEVEL_RANGES[q]; return (level - lo) / Math.max(hi - lo, 1); };
const windowRange = (range, level, ratio = .4) => { const [min, max] = range; const span = max - min; if (span <= 0) return [min, max]; const window = span < 2 ? span : Math.max(1, span * ratio); const start = min + (span - window) * progress(level); return [Math.max(min, Math.round(start)), Math.min(max, Math.round(start + window))]; };
const levelRule = (category, level) => { const base = RULES[category]?.[qualityFromLevel(level)]; if (!base) return null; if (category === '武器') return { 命中: windowRange(base.命中, level, .7), 期望伤害: windowRange(base.期望伤害, level, .4) }; if (category === '技能') return { 期望伤害: windowRange(base.期望伤害, level, .4), 消耗: windowRange(base.消耗, level, .5) }; if (category === '血统') return { ...base, 预算: windowRange(base.预算, level, .45) }; return { DEF: windowRange(base.DEF, level, 1), MDEF: windowRange(base.MDEF, level, 1) }; };
const priceRangeForLevel = level => [...(RULES.价格区间[qualityFromLevel(level)] || RULES.价格区间.F)];
const randomInt = (rng, min, max) => rng.int(Math.ceil(min), Math.floor(max));
const getStatInRange = (rng, rank, total, min, max) => { const ratio = rank / Math.max(total - 1, 1); const subMin = min + Math.floor((max - min) * Math.max(0, ratio - .25)); const subMax = min + Math.ceil((max - min) * Math.min(1, ratio + .25)); return randomInt(rng, subMin, subMax); };
const tieredPrices = (rng, range, count) => {
    const [min, max] = range;
    // SSS is explicitly open-ended in the card. Local fallback uses its minimum;
    // a model may still provide a higher price, but mergeApiCatalog will lock it.
    if (!Number.isFinite(max)) return Array.from({ length: count }, () => min);
    const step = (max - min) / (count + 1);
    return Array.from({ length: count }, (_, i) => {
        const base = min + step * (i + 1);
        return randomInt(rng, Math.max(min, Math.floor(base - step * .4)), Math.min(max, Math.ceil(base + step * .4)));
    });
};
const diceFromExpected = (target, min, max) => { const faces = [4, 6, 8, 10, 12, 14, 16, 18, 20]; const maxCount = Math.max(1, Math.ceil(target / 2.5) + 2); let best = { count: 1, face: 4, score: Infinity }; let inRange = null; let tolerance = null; for (let count = 1; count <= maxCount; count += 1) for (const face of faces) { const exp = count * (face + 1) / 2; const candidate = { count, face, score: Math.abs(exp - target) + count * .02 }; if (candidate.score < best.score) best = candidate; if (exp >= min && exp <= max && (!inRange || candidate.score < inRange.score)) inRange = candidate; if (exp >= min * .9 && exp <= max * 1.1 && (!tolerance || candidate.score < tolerance.score)) tolerance = candidate; } const result = inRange || tolerance || best; return `${result.count}d${result.face}`; };
const randomUnit = rng => rng.nextUint32() / 0x100000000;
const diceForRank = (rng, rank, total, min, max) => { const ratio = rank / Math.max(total - 1, 1); const base = min + (max - min) * ratio; const jitter = (max - min) * .15 * (randomUnit(rng) * 2 - 1); return diceFromExpected(Math.max(min, Math.min(max, base + jitter)), min, max); };
const profileText = (rng, text) => { const parts = String(text || '').split(/[\/／]/).map(v => v.trim()).filter(Boolean); return parts.length ? parts[randomInt(rng, 0, parts.length - 1)] : text; };
const normalizeTarget = (target = {}) => { const raw = Array.isArray(target.categories) && target.categories.length ? target.categories : target.category ? [target.category] : ['all']; const categories = raw.includes('all') ? Object.keys(CATEGORY_KEYS) : unique(raw).map(item => CATEGORY_ALIASES[item] || item).filter(item => CATEGORY_KEYS[item]); const slots = unique(target.slotPreferences || target.slots).filter(item => VALID_SLOTS.includes(item)); return { categories: categories.length ? categories : Object.keys(CATEGORY_KEYS), slots, count: Math.max(0, Math.min(50, Math.round(num(target.count, 0)))), query: String(target.query || '').slice(0, 500), autonomous: Boolean(target.autonomous) }; };
export { normalizeTarget };

export function emptyCatalog() { return { 血统列表: [], 技能列表: [], 装备列表: [], 道具列表: [], 升级列表: [], 成员商库: {} }; }
const normalizeItem = (item = {}, key, index) => ({ id: String(item.id || `${key}-${index + 1}`), ...deepClone(item) });
const classifyFlatShopItem = item => {
    if (!item || typeof item !== 'object') return null;
    if (item.升级自 || item.升级类型 || item.替换目标 || item.所属大类) return '升级列表';
    if (item.被动属性 || item.原始属性 && !item.数量 && !item.消耗 && item.类型 === undefined) return '血统列表';
    if (item.类型 === '主动' || item.类型 === '被动' || item.技能类型分类 || item.消耗 !== undefined && item.数量 === undefined && item.原始属性 === undefined) return '技能列表';
    if (VALID_SLOTS.includes(item.类型) || Number.isInteger(item.类型) && item.原始属性 || item.命中 !== undefined || item.DEF !== undefined || item.MDEF !== undefined) return '装备列表';
    if (item.数量 !== undefined || item.效果 !== undefined || item.道具类型 !== undefined) return '道具列表';
    return null;
};
export function normalizeCatalog(value) { const source = value?.商城 && typeof value.商城 === 'object' ? value.商城 : value || {}; const out = emptyCatalog(); for (const key of Object.values(CATEGORY_KEYS)) if (Array.isArray(source[key])) out[key] = source[key].map((item, index) => normalizeItem(item, key, index)); const flat = Array.isArray(source.商品列表) ? source.商品列表 : Array.isArray(source.items) ? source.items : []; flat.forEach(item => { const key = classifyFlatShopItem(item); if (key) out[key].push(normalizeItem(item, key, out[key].length)); }); if (source.成员商库 && typeof source.成员商库 === 'object') out.成员商库 = deepClone(source.成员商库); return out; }
const nextId = (prefix, rng) => `${prefix}_${rng.nextUint32().toString(16)}`;
const bloodlineStats = (budget, rank) => { const ps = {}; let remaining = budget; const spend = cost => { remaining = Math.max(0, remaining - cost); }; const addFlat = (key, cost, maxCount = 999) => { const count = Math.min(maxCount, Math.floor(remaining / cost)); if (count > 0) { ps[key] = (ps[key] || 0) + count; spend(count * cost); } }; const addPool = (key) => { const unit = key === 'HP加成' ? 2 : 5; const value = Math.floor(remaining) * unit; if (value > 0) { ps[key] = (ps[key] || 0) + value; spend(value / unit); } }; if (rank % 4 === 0) { addFlat('DEF加成', 5, Math.max(1, Math.floor(budget / 18))); addPool('HP加成'); } else if (rank % 4 === 1) { addFlat('ATK加成', 5, Math.max(1, Math.floor(budget / 20))); addPool('HP加成'); } else if (rank % 4 === 2) { addFlat('法术ATK加成', 5, Math.max(1, Math.floor(budget / 20))); if (remaining >= 2) { const pct = Math.floor(remaining / 2) * 2; ps.法术强度加成 = (ps.法术强度加成 || 0) + pct; spend(pct / 2); } addPool('MP加成'); } else { addFlat('豁免加成', 3, Math.max(1, Math.floor(budget / 18))); addPool('MP加成'); } return ps; };
const sourceEntries = source => Object.entries(source || {}).filter(([, item]) => item && typeof item === 'object' && item.状态 !== '被夺取' && (item.层级 || item.等级 || item.位阶));
const diceExpected = value => { const match = String(value || '').replace(/\s/g, '').match(/^(\d+)d(\d+)$/i); return match ? Number(match[1]) * (Number(match[2]) + 1) / 2 : null; };
const passiveUnits = { HP加成: { value: 2, cost: 1 }, MP加成: { value: 5, cost: 1 }, ATK加成: { value: 1, cost: 5 }, DEF加成: { value: 1, cost: 5 }, 法术ATK加成: { value: 1, cost: 5 }, MDEF加成: { value: 1, cost: 5 }, 豁免加成: { value: 1, cost: 3 }, 法术强度加成: { value: 2, cost: 1 } };
const passiveBudget = stats => { const s = stats || {}; return Math.abs(num(s.HP加成)) / 2 + Math.abs(num(s.MP加成)) / 5 + Math.abs(num(s.ATK加成)) * 5 + Math.abs(num(s.DEF加成)) * 5 + Math.abs(num(s.法术ATK加成)) * 5 + Math.abs(num(s.MDEF加成)) * 5 + Math.abs(num(s.豁免加成)) * 3 + Math.abs(num(s.法术强度加成)) / 2; };
const upgradePassive = (sourceStats, targetBudget, rank, rng) => { const ps = deepClone(sourceStats || {}); const oldBudget = passiveBudget(ps); if (oldBudget <= 0) return bloodlineStats(targetBudget, rank); const preferred = Object.keys(passiveUnits).filter(key => num(ps[key]) > 0); let index = 0; while (passiveBudget(ps) < targetBudget && index < 200) { let key = preferred.length ? preferred[index % preferred.length] : rank % 2 === 0 ? 'HP加成' : 'MP加成'; let unit = passiveUnits[key]; const remaining = targetBudget - passiveBudget(ps); if (unit.cost > remaining && remaining < 5) { key = 'HP加成'; unit = passiveUnits[key]; } ps[key] = num(ps[key]) + unit.value; index += 1; } return ps; };
const upgradeItems = (hero, level, range, rng) => { const list = []; const quality = qualityFromLevel(level); const skillRule = levelRule('技能', level); const bloodRule = levelRule('血统', level); const weaponRule = levelRule('武器', level); const add = (source, type) => sourceEntries(source).filter(([, item]) => num(item.等级) < level).forEach(([name, old], rank) => { const normal = tieredPrices(rng, range, 1)[0]; const item = { id: nextId('up', rng), 名称: name, 等级: level, 品质: quality, 价格: Math.max(1, Math.floor(normal * .7)), 原价: normal, 升级自: name, 升级类型: type, 原等级: num(old.等级), 原品质: old.品质, 升级优惠: '30%', 升级说明: `${name} 的升级版，购买后替换原条目。`, 描述: old.描述 || '', _forgeType: type, 类型: type }; if (type === '技能') { item.技能类型分类 = old.类型 === '被动' ? '被动' : '主动'; item.消耗 = item.技能类型分类 === '主动' ? Math.max(skillRule.消耗[0], Math.min(skillRule.消耗[1], num(old.消耗, skillRule.消耗[0]))) : 0; item.标签 = unique(old.标签); item.效果 = old.效果 || ''; item.伤害属性 = old.伤害属性 ?? null; const hasDamage = Boolean(old.伤害) && (!item.标签.length || item.标签.includes('伤害') || item.标签.includes('攻击')); if (item.技能类型分类 === '主动' && hasDamage) item.伤害 = diceForRank(rng, rank, 1, skillRule.期望伤害[0], skillRule.期望伤害[1]); } else if (type === '血统') { const oldStats = old.被动属性 || {}; const targetBudget = Math.max(bloodRule.预算[0], Math.min(bloodRule.预算[1], Math.ceil(Math.max(bloodRule.预算[0], passiveBudget(oldStats) + (bloodRule.预算[1] - bloodRule.预算[0]) * (.25 + randomUnit(rng) * .2))))); item.被动属性 = upgradePassive(oldStats, targetBudget, rank, rng); item.特殊效果 = deepClone(old.特殊效果 || {}); item.标签 = unique(old.标签); } else { const rawSlot = old.槽位 || old.类型 || old.部位 || '饰品'; const armorSlots = ['铠甲', '胸甲', '头盔', '腿甲', '鞋子', '盾', '盾牌', '护甲', '长袍']; const subtype = rawSlot === '武器' || old.伤害 || old.命中 ? '武器' : armorSlots.includes(rawSlot) || old.DEF !== undefined || old.MDEF !== undefined ? '防具' : '饰品'; item.类型 = '装备'; item.槽位 = rawSlot; item.子类型 = subtype; item.标签 = unique(old.标签); item.特效 = old.特效; if (subtype === '武器') { const expected = diceExpected(old.伤害) || weaponRule.期望伤害[0]; item.命中 = Math.max(weaponRule.命中[0], Math.min(weaponRule.命中[1], num(old.命中, weaponRule.命中[0]))); item.伤害 = diceForRank(rng, 0, 1, weaponRule.期望伤害[0], weaponRule.期望伤害[1]); if (expected > weaponRule.期望伤害[0]) item.伤害 = diceFromExpected(Math.max(weaponRule.期望伤害[0], Math.min(weaponRule.期望伤害[1], expected * (1.12 + randomUnit(rng) * .12))), weaponRule.期望伤害[0], weaponRule.期望伤害[1]); } else if (subtype === '防具') { const armor = levelRule(rawSlot.includes('盾') ? '盾牌防具' : rawSlot.includes('头') ? '头部防具' : rawSlot.includes('腿') ? '腿部防具' : '身体防具', level); item.DEF = Math.max(armor.DEF[0], Math.min(armor.DEF[1], num(old.DEF, armor.DEF[0]))); item.MDEF = Math.max(armor.MDEF[0], Math.min(armor.MDEF[1], num(old.MDEF, armor.MDEF[0]))); } } list.push(item); }); add(hero?.技能, '技能'); add(hero?.血统, '血统'); add(hero?.装备栏 || hero?.装备, '装备'); return list; };

const compactPassiveStats = (stats = {}) => Object.fromEntries(Object.entries(stats).filter(([, value]) => Number(value) !== 0 && value !== undefined && value !== null));
const compactSpecialEffects = (value) => {
    if (!value || typeof value !== 'object') return null;
    const 增益 = Array.isArray(value.增益) ? value.增益.filter(Boolean) : [];
    const 副作用 = Array.isArray(value.副作用) ? value.副作用.filter(Boolean) : [];
    return 增益.length || 副作用.length ? { 增益, 副作用 } : null;
};
const appendUpgradeFields = (output, item) => {
    if (item.升级自 !== undefined && item.升级自 !== null && item.升级自 !== '') output.替换目标 = item.升级自;
    if (item.升级类型 !== undefined && item.升级类型 !== null && item.升级类型 !== '') output.所属大类 = item.升级类型;
    return output;
};
const EQUIPMENT_TYPE_BY_SLOT = { 武器: 0, 手套: 1, 拳套: 1, 头盔: 2, 铠甲: 3, 胸甲: 3, 腿甲: 4, 腿裤: 4, 鞋子: 5, 披风: 6, 斗篷: 6, 饰品: 7, 腰带: 7, 盾: 8, 盾牌: 8 };
const qualityAttributeRecord = quality => Object.fromEntries(['力量', '敏捷', '体质', '精神', '魅力'].map(key => [key, quality]));
const itemEffectRecord = value => value && typeof value === 'object' ? deepClone(value) : (value ? { 描述: String(value) } : {});
const skillTypeNumber = item => item.技能类型分类 === '被动' || item.类型 === '被动' ? 1 : Number.isInteger(item.类型) ? Math.max(0, Math.min(2, item.类型)) : 0;
// Mirrors the card's convertToChinese() boundary: internal forge fields never
// leak into the saved catalogue, while the app id is retained for UI selection.
const convertShopItem = (item = {}) => {
    const id = item.id;
    if (item.类型 === '技能' || item._forgeType === '技能') {
        return appendUpgradeFields({ ...(id ? { id } : {}), 名称: item.名称, 品质: item.品质, 类型: skillTypeNumber(item), 消耗: String(item.消耗 ?? 0), ...(item.标签?.length ? { 标签: item.标签 } : {}), 效果: itemEffectRecord(item.效果 || (item.伤害 ? { 伤害: item.伤害, 伤害属性: item.伤害属性 || '' } : null)), 描述: item.描述 ?? '', ...(item.价格 != null ? { 价格: item.价格 } : {}) }, item);
    }
    if (item.类型 === '血统' || item._forgeType === '血统') {
        const passive = compactPassiveStats(item.被动属性 || {});
        const special = compactSpecialEffects(item.特殊效果);
        return appendUpgradeFields({ ...(id ? { id } : {}), 名称: item.名称, 品质: item.品质, 原始属性: item.原始属性 || qualityAttributeRecord(item.品质), ...(Object.keys(passive).length ? { 效果: { 被动属性: passive } } : {}), ...(special ? { 特殊效果: special } : {}), 描述: item.描述 ?? '', ...(item.标签?.length ? { 标签: item.标签 } : {}), ...(item.附带技能 ? { 附带技能: item.附带技能 } : {}), ...(item.价格 != null ? { 价格: item.价格 } : {}) }, item);
    }
    if (item.类型 === '装备' || item._forgeType === '装备') {
        const slot = item.槽位 || item.部位 || '饰品';
        const raw = item.原始属性 || (slot === '武器' ? { ATK: item.品质 } : { DEF: item.品质, MDEF: item.品质 });
        const tags = unique([...(item.标签 || []), slot]);
        return appendUpgradeFields({ ...(id ? { id } : {}), 名称: item.名称, 品质: item.品质, 类型: EQUIPMENT_TYPE_BY_SLOT[slot] ?? 7, 原始属性: raw, 效果: itemEffectRecord(item.效果 || item.特效), 描述: item.描述 ?? '', ...(tags.length ? { 标签: tags } : {}), ...(item.价格 != null ? { 价格: item.价格 } : {}) }, item);
    }
    if (item.类型 === '道具' || item._forgeType === '道具') {
        return appendUpgradeFields({ ...(id ? { id } : {}), 名称: item.名称, 品质: item.品质, 类型: item.道具类型 || item.类型 || '消耗品', 数量: item.数量 ?? 1, 效果: itemEffectRecord(item.效果), ...(item.标签?.length ? { 标签: item.标签 } : {}), 描述: item.描述 ?? '', ...(item.价格 != null ? { 价格: item.价格 } : {}) }, item);
    }
    return deepClone(item);
};

export function generateShopDraft({ playerLevel = 1, slotPreferences = [], target = {}, seed, hero = {}, currentCatalog = {} } = {}) {
    const level = normalizeLifeLevel(playerLevel); const normalized = normalizeTarget({ ...target, slotPreferences }); const rng = new DeterministicRng(seed256(seed || `${level}:${JSON.stringify(normalized)}`)); const range = priceRangeForLevel(level); const quality = qualityFromLevel(level); const generated = emptyCatalog(); const skillIds = []; const has = category => normalized.categories.includes(category);
    if (has('upgrade')) generated.升级列表 = upgradeItems(hero, level, range, rng);
    if (has('skill')) { const count = randomInt(rng, 2, 3); const prices = tieredPrices(rng, range, count); const rule = levelRule('技能', level); generated.技能列表 = Array.from({ length: count }, (_, rank) => { const id = nextId('sk', rng); skillIds.push(id); return { id, 名称: '___FILL_INFO___', 等级: level, 品质: quality, 类型: '技能', 技能类型分类: '主动', 价格: prices[rank], 伤害: diceForRank(rng, rank, count, rule.期望伤害[0], rule.期望伤害[1]), 伤害属性: '___FILL_INFO___', 消耗: getStatInRange(rng, rank, count, rule.消耗[0], rule.消耗[1]), 标签: ['攻击', '伤害'], 效果: '___FILL_INFO___', 描述: '___FILL_INFO___' }; }); }
    if (has('bloodline')) { const count = randomInt(rng, 2, 3); const prices = tieredPrices(rng, range, count); const rule = levelRule('血统', level); generated.血统列表 = Array.from({ length: count }, (_, rank) => { const item = { id: nextId('bl', rng), 名称: '___FILL_INFO___', 等级: level, 品质: quality, 类型: '血统', 价格: prices[rank], 被动属性: bloodlineStats(getStatInRange(rng, rank, count, rule.预算[0], rule.预算[1]), rank) }; if (rule.附赠技能品质 !== null && skillIds.length) item.附带技能 = skillIds[rank % skillIds.length]; return item; }); }
    if (has('equipment')) for (const slot of SLOT_TABLE) { const preferred = normalized.slots.includes(slot.槽位) || (slot.槽位 === '武器' && normalized.slots.includes('法术武器')); const count = slot.槽位 === '武器' ? (preferred ? randomInt(rng, 3, 4) : randomInt(rng, 2, 3)) : slot.子类型 === '防具' ? (preferred ? randomInt(rng, 2, 3) : randomInt(rng, 1, 2)) : (normalized.slots.length ? randomInt(rng, 0, 1) : randomInt(rng, 0, 2)); if (count <= 0) continue; const prices = tieredPrices(rng, range, count); const rule = slot.子类型 === '武器' ? levelRule('武器', level) : levelRule(slot.防具类型, level); for (let rank = 0; rank < count; rank += 1) { const item = { id: nextId('eq', rng), 名称: '___FILL_INFO___', 类型: '装备', 等级: level, 品质: quality, 价格: prices[rank], 子类型: slot.子类型, 槽位: slot.槽位, 描述: '___FILL_INFO___' }; if (slot.子类型 === '武器') { const magic = normalized.slots.includes('法术武器') && !normalized.slots.includes('武器') ? true : normalized.slots.includes('法术武器') && normalized.slots.includes('武器') ? rank % 2 === 1 : randomUnit(rng) < .35; const profile = (magic ? ARTIFACT_PROFILES : WEAPON_PROFILES).filter(p => QUALITY_ORDER.indexOf(p.min) <= Math.min(QUALITY_ORDER.indexOf(quality) + (randomUnit(rng) < .18 ? 1 : 0), QUALITY_ORDER.indexOf('C'))); item.命中 = getStatInRange(rng, rank, count, rule.命中[0], rule.命中[1]); item.伤害 = diceForRank(rng, rank, count, rule.期望伤害[0], rule.期望伤害[1]); const picked = profile[randomInt(rng, 0, Math.max(0, profile.length - 1))] || (magic ? ARTIFACT_PROFILES : WEAPON_PROFILES)[0]; item.标签 = unique([profileText(rng, picked.type), profileText(rng, picked.mode), magic ? '法术' : '物理', '攻击', '武器']); } else if (slot.子类型 === '防具') { item.DEF = getStatInRange(rng, rank, count, rule.DEF[0], rule.DEF[1]); item.MDEF = getStatInRange(rng, rank, count, rule.MDEF[0], rule.MDEF[1]); item.标签 = ['轻便', '防具']; if (!['腿甲', '头盔'].includes(slot.槽位)) item.标签 = ['防具']; } else { item.特效 = '___FILL_INFO___'; item.标签 = slot.槽位 === '鞋子' ? ['轻便', '脱身', '饰品'] : ['特殊', '饰品']; } generated.装备列表.push(item); } }
    if (has('item')) { const count = randomInt(rng, 2, 3); const prices = tieredPrices(rng, range, count); generated.道具列表 = Array.from({ length: count }, (_, rank) => ({ id: nextId('it', rng), 名称: '___FILL_INFO___', 类型: '道具', 等级: level, 品质: quality, 价格: prices[rank], 数量: 1, 道具类型: '___FILL_INFO___', 效果: '___FILL_INFO___', 标签: rank % 2 === 0 ? ['脱身'] : ['潜行'], 描述: '___FILL_INFO___' })); }
    const converted = emptyCatalog();
    for (const key of Object.values(CATEGORY_KEYS)) converted[key] = generated[key].map(convertShopItem);
    const catalog = normalizeCatalog(currentCatalog); for (const key of Object.values(CATEGORY_KEYS)) if (has(Object.keys(CATEGORY_KEYS).find(k => CATEGORY_KEYS[k] === key))) catalog[key] = converted[key];
    return { catalog, generated: converted, target: normalized, playerLevel: level, baseQuality: quality, priceRange: range, seed: seed256(seed || `${level}:${JSON.stringify(normalized)}`), rulesetVersion: SHOP_RULESET_VERSION, rngIndex: rng.index };
}

export function mergeApiCatalog(draftCatalog, responseCatalog, target) {
    const result = normalizeCatalog(draftCatalog); const incoming = normalizeCatalog(responseCatalog); const fields = ['名称', '标签', '描述', '效果', '特效', '特殊效果', '道具类型', '伤害属性'];
    for (const category of target.categories) { const key = CATEGORY_KEYS[category]; const items = incoming[key]?.length ? incoming[key] : (draftCatalog[key] || []); result[key] = items.slice(0, draftCatalog[key]?.length || items.length || 50).map((item, index) => { const base = draftCatalog[key]?.[index] || {}; const safe = Object.fromEntries(fields.filter(field => item[field] !== undefined).map(field => [field, item[field]])); return { ...deepClone(base), ...safe, id: base.id || item.id }; }); }
    return result;
}

export function shopModelPrompt({ draft, target, playerLevel, characterName, query }) {
    const roman = lifeLevelRoman(playerLevel);
    return `你是《轮回战场》V3.2.6 卡片的 forge_shop 文案填充器。严格按嵌入卡片规则工作。玩家生命层级只读，范围是罗马数字 Ⅰ–Ⅸ（对应阿拉伯数字 1–9），映射为 Ⅰ↔F、Ⅱ↔E、Ⅲ↔D、Ⅳ↔C、Ⅴ↔B、Ⅵ↔A、Ⅶ↔S、Ⅷ↔SS、Ⅸ↔SSS；不得自行改生命层级、品质、价格或任何数值。价格区间必须严格使用 F[10,99]、E[100,999]、D[1000,4999]、C[5000,19999]、B[20000,79999]、A[80000,319999]、S[320000,1270000]、SS[1280000,5110000]、SSS[5120000,+∞]。${target?.autonomous ? '你必须自主决定刷新目标，先输出刷新目标.categories和刷新目标.slotPreferences；只返回你决定刷新的类别，其余列表为空。' : ''}输出单个 JSON 对象，键必须包含 刷新目标、血统列表、技能列表、装备列表、道具列表、升级列表；也兼容直接返回商品列表。只允许补全名称、标签、描述、效果、特效、伤害属性和道具类型，不得改动卡片草案中的品质、价格、原始属性、消耗或附带技能引用。当前目标：${JSON.stringify(target)}；生命层级：${roman}（${normalizeLifeLevel(playerLevel)}）；人物：${characterName || '轮回者'}；额外要求：${query || '无'}。\n草案：${JSON.stringify(draft)}`;
}
