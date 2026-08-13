import { makeId } from './util.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const asNumber = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export const QUALITY_DC = Object.freeze({ F: 40, E: 50, D: 75, C: 100, B: 130, A: 160, S: 190, SS: 230, SSS: 280 });

export function checkOutcome(raw, total, dc) {
    if (raw <= 5) return 'disaster';
    if (raw >= 96) return 'miracle';
    return total >= dc ? 'success' : 'failure';
}

export function targetCostMultiplier(count) {
    return count <= 1 ? 1 : count === 2 ? 1.5 : count === 3 ? 2 : count === 4 ? 2.5 : 3;
}

export function normalizeEncounter(draft = {}) {
    const zones = Array.isArray(draft.zones) && draft.zones.length ? draft.zones : [{ id: 'zone-main', name: draft.location || '当前战场', adjacent: [], capacity: 6, narrow: false }];
    const normalizedZones = zones.map((zone, index) => ({
        id: String(zone.id || `zone-${index + 1}`), name: String(zone.name || `区域 ${index + 1}`),
        adjacent: Array.isArray(zone.adjacent) ? zone.adjacent.map(String) : [], capacity: clamp(zone.capacity ?? (zone.narrow ? 3 : 6), 1, 1000),
        narrow: Boolean(zone.narrow), cover: clamp(zone.cover, 0, 50), blocked: Boolean(zone.blocked), hazard: zone.hazard || null,
    }));
    const validZones = new Set(normalizedZones.map(zone => zone.id));
    const usedIds = new Set();
    const combatants = (draft.combatants || []).flatMap((source, sourceIndex) => {
        const count = clamp(source.count || source['数量'] || 1, 1, 1000);
        return Array.from({ length: count }, (_none, memberIndex) => {
            let id = String(source.id || `unit-${sourceIndex + 1}`);
            if (count > 1) id = `${id}-${String(memberIndex + 1).padStart(3, '0')}`;
            while (usedIds.has(id)) id = makeId('unit-');
            usedIds.add(id);
            const maxHp = Math.max(1, asNumber(source.maxHp ?? source.HP_MAX ?? source.hp, 20));
            const maxEp = Math.max(0, asNumber(source.maxEp ?? source.EP_MAX ?? source.ep, 0));
            return {
                id, templateId: String(source.templateId || source.id || source.name || `template-${sourceIndex}`),
                name: count > 1 ? `${source.name || '单位'} ${memberIndex + 1}` : String(source.name || id),
                side: source.side === 'enemy' ? 'enemy' : source.side === 'neutral' ? 'neutral' : 'player',
                controller: source.controller || (source.side === 'enemy' ? 'ai' : source.isPlayer === false ? 'ai' : 'player'),
                playerId: source.playerId || 'local-player', seatId: source.seatId || 'seat-1',
                hp: clamp(source.hp ?? maxHp, 0, maxHp), maxHp, ep: clamp(source.ep ?? maxEp, 0, maxEp), maxEp,
                thp: Math.max(0, asNumber(source.thp, 0)), attack: asNumber(source.attack ?? source.ATK, 10), magicAttack: asNumber(source.magicAttack ?? source.MATK, 10),
                attackModifier: asNumber(source.attackModifier, Math.floor((asNumber(source.primaryAttribute, 10) - 10) / 2)),
                defenseDC: asNumber(source.defenseDC ?? source.DEF, 50), initiativeDC: asNumber(source.initiativeDC, 0),
                armor: clamp(source.armor ?? source.physicalReduction, 0, 95), resistance: clamp(source.resistance ?? source.magicalReduction, 0, 95),
                tierCorrection: asNumber(source.tierCorrection, 0), zoneId: validZones.has(String(source.zoneId)) ? String(source.zoneId) : normalizedZones[0].id,
                range: source.range || 'contact', statuses: Array.isArray(source.statuses) ? source.statuses : [], cooldowns: source.cooldowns || {},
                abilities: normalizeAbilities(source.abilities), state: source.hp === 0 ? 'dying' : 'active', dyingHits: 0,
                boss: Boolean(source.boss), elite: Boolean(source.elite), named: Boolean(source.named || source.boss),
                phases: Array.isArray(source.phases) ? source.phases : source.boss ? [70, 40, 15] : [], reachedPhases: [], kills: 0,
            };
        });
    });
    if (!combatants.some(unit => unit.side === 'player') || !combatants.some(unit => unit.side === 'enemy')) throw new Error('遭遇必须至少包含一名玩家方和一名敌方单位');
    return { title: String(draft.title || '未命名遭遇'), location: String(draft.location || normalizedZones[0].name), description: String(draft.description || ''), zones: normalizedZones, combatants };
}

function normalizeAbilities(abilities) {
    const list = Array.isArray(abilities) ? abilities : [];
    const output = list.map((ability, index) => ({
        id: String(ability.id || `ability-${index + 1}`), name: String(ability.name || `能力 ${index + 1}`), type: ability.type || 'physical', actionType: ability.actionType === 'minor' ? 'minor' : 'main',
        power: Math.max(0, asNumber(ability.power, 0)), modifier: asNumber(ability.modifier, 0), epCost: Math.max(0, asNumber(ability.epCost, 0)),
        range: ability.range || 'contact', targetCount: clamp(ability.targetCount || 1, 1, 1000), aoe: Boolean(ability.aoe), weakPoint: Boolean(ability.weakPoint),
        script: typeof ability.script === 'string' ? ability.script : null,
    }));
    if (!output.some(item => item.id === 'basic-attack')) output.unshift({ id: 'basic-attack', name: '基础攻击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, range: 'contact', targetCount: 1, aoe: false, weakPoint: false, script: null });
    return output;
}

export function living(unit) { return unit.state === 'active' && unit.hp > 0; }
export function enemiesOf(state, actor) { return state.combatants.filter(unit => living(unit) && unit.side !== actor.side && unit.side !== 'neutral'); }
export function alliesOf(state, actor) { return state.combatants.filter(unit => living(unit) && unit.side === actor.side); }

export function rangeLegal(state, actor, target, ability) {
    if (actor.zoneId === target.zoneId) return true;
    if (ability.range === 'far') return true;
    const zone = state.zones.find(item => item.id === actor.zoneId);
    return ability.range !== 'contact' && zone?.adjacent.includes(target.zoneId);
}

export function damageValue(actor, target, ability, critical = false) {
    const panel = ability.type === 'magical' ? actor.magicAttack : actor.attack;
    let raw = Math.max(0, panel + ability.power);
    if (critical || ability.weakPoint) raw *= 1.5;
    const reduction = ability.type === 'true' ? 0 : ability.type === 'magical' ? target.resistance : target.armor;
    return { raw: Math.round(raw), reduction, final: Math.max(0, Math.round(raw * (1 - reduction / 100))) };
}

export function applyDamage(target, amount) {
    const before = { hp: target.hp, thp: target.thp, state: target.state };
    let remaining = Math.max(0, amount);
    const absorbed = Math.min(target.thp, remaining); target.thp -= absorbed; remaining -= absorbed;
    target.hp = Math.max(0, target.hp - remaining);
    if (target.hp <= 0) {
        if (target.state === 'dying') { target.state = 'dead'; target.dyingHits += 1; }
        else { target.state = 'dying'; target.dyingHits = 0; }
    }
    return { before, after: { hp: target.hp, thp: target.thp, state: target.state }, absorbed, hpDamage: remaining };
}

export function aggregateCohorts(combatants) {
    const groups = new Map();
    for (const unit of combatants) {
        const key = unit.boss || unit.elite || unit.named ? unit.id : `${unit.side}:${unit.templateId}:${unit.zoneId}:${unit.state}`;
        const group = groups.get(key) || { key, name: unit.name.replace(/ \d+$/, ''), side: unit.side, zoneId: unit.zoneId, state: unit.state, count: 0, totalHp: 0, totalMaxHp: 0, ids: [] };
        group.count += 1; group.totalHp += unit.hp + unit.thp; group.totalMaxHp += unit.maxHp; group.ids.push(unit.id); groups.set(key, group);
    }
    return [...groups.values()];
}
