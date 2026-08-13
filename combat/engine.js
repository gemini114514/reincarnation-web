import { aggregateCohorts, alliesOf, applyDamage, damageValue, enemiesOf, living, normalizeEncounter, rangeLegal, targetCostMultiplier } from './rules.js';
import { evaluateTriggers } from './strategy.js';
import { inspectScript, runScript, scriptHash } from './sandbox.js';
import { canonical, deepClone, DeterministicRng, makeId, RULESET_VERSION, seed256, sha256 } from './util.js';

const MODES = new Set(['manual', 'semi', 'auto']);

export class CombatEngine {
    constructor(repository) { this.repository = repository; }

    create(input = {}) {
        const encounter = normalizeEncounter(input.encounter || input);
        const seed = seed256(input.seed);
        const state = {
            id: makeId('battle-'), storySessionId: input.storySessionId || null, rulesetVersion: RULESET_VERSION,
            status: 'draft', version: 1, sequence: 0, seed, rng: new DeterministicRng(seed).snapshot(), mode: MODES.has(input.mode) ? input.mode : 'manual',
            lastEventHash: null,
            playerId: input.playerId || 'local-player', seatId: input.seatId || 'seat-1', title: encounter.title, location: encounter.location, description: encounter.description,
            zones: encounter.zones, combatants: encounter.combatants, initialSnapshot: null, initialHash: null,
            initialCounts: { player: encounter.combatants.filter(unit => unit.side === 'player').length, enemy: encounter.combatants.filter(unit => unit.side === 'enemy').length },
            round: 0, initiative: [], cursor: 0, activeUnitId: null, strategy: null, pendingReaction: null, pauseReason: null,
            flags: {}, noChangeRounds: 0, lastProgressHash: null, approvedScripts: [], finalResult: null, pendingEvents: [], createdAt: new Date().toISOString(),
        };
        state.initialSnapshot = deepClone({ zones: state.zones, combatants: state.combatants });
        state.initialHash = sha256(state.initialSnapshot);
        this.event(state, 'combat_created', { title: state.title, mode: state.mode, seed: state.seed, initialHash: state.initialHash });
        const pending = state.pendingEvents.splice(0);
        this.repository.create(state);
        for (const event of pending) this.repository.appendEvent(state.id, event);
        return this.publicState(state);
    }

    publicState(state) {
        const value = deepClone(state);
        delete value.pendingEvents;
        value.cohorts = aggregateCohorts(value.combatants);
        value.eventHash = state.lastEventHash || null;
        return value;
    }

    event(state, type, payload = {}) {
        const previousHash = state.lastEventHash || 'GENESIS';
        const body = { battleId: state.id, sequence: ++state.sequence, timestamp: new Date().toISOString(), round: state.round, type, payload };
        const deterministicBody = { sequence: body.sequence, round: body.round, type, payload };
        const event = { ...body, previousHash, hash: sha256(`${previousHash}\n${canonical(deterministicBody)}`) };
        state.lastEventHash = event.hash;
        state.pendingEvents.push(event);
        return event;
    }

    assertWritable(state, expectedVersion) {
        if (!state) throw httpError(404, '战斗不存在');
        if (expectedVersion !== undefined && Number(expectedVersion) !== state.version) throw httpError(409, `状态版本冲突：当前为 ${state.version}`);
        if (['completed', 'abandoned'].includes(state.status)) throw httpError(409, '战斗已结束');
    }

    async start(state) {
        this.assertWritable(state);
        if (!['draft', 'ready', 'paused'].includes(state.status)) throw httpError(409, '当前状态不能开始战斗');
        for (const unit of state.combatants) for (const ability of unit.abilities) {
            if (!ability.script) continue;
            const hash = scriptHash(ability.script);
            ability.scriptHash = hash;
            if (!this.repository.isScriptApproved(hash, state.rulesetVersion)) {
                state.status = 'awaiting_script_approval'; state.pauseReason = { type: 'script_approval', unitId: unit.id, abilityId: ability.id, inspection: inspectScript(ability.script, ability) };
                this.event(state, 'script_approval_required', state.pauseReason); return;
            }
            if (!state.approvedScripts.includes(hash)) state.approvedScripts.push(hash);
        }
        state.status = 'running'; state.pauseReason = null;
        if (!state.initialized) { state.initialized = true; this.beginRound(state); }
        await this.advanceUntilPause(state, state.mode === 'manual' ? 1000 : 10000);
    }

    beginRound(state) {
        state.round += 1; state.flags = {}; state.engagements = {}; state.turnBudget = {};
        const rng = this.rng(state);
        for (const unit of state.combatants) {
            if (!living(unit)) continue;
            const beforeStatuses = deepClone(unit.statuses);
            for (const status of unit.statuses) {
                if (Number(status.damagePerRound) > 0) { const applied = applyDamage(unit, Number(status.damagePerRound)); this.event(state, 'periodic_damage', { unitId: unit.id, status: status.id, amount: status.damagePerRound, applied }); }
                if (Number(status.healPerRound) > 0) { const before = unit.hp; unit.hp = Math.min(unit.maxHp, unit.hp + Number(status.healPerRound)); this.event(state, 'periodic_heal', { unitId: unit.id, status: status.id, before, after: unit.hp }); }
            }
            unit.statuses = unit.statuses.map(status => ({ ...status, duration: Number(status.duration || 1) - 1 })).filter(status => status.duration > 0);
            for (const key of Object.keys(unit.cooldowns)) unit.cooldowns[key] = Math.max(0, Number(unit.cooldowns[key]) - 1);
            if (canonical(beforeStatuses) !== canonical(unit.statuses)) this.event(state, 'status_refreshed', { unitId: unit.id, before: beforeStatuses, after: unit.statuses });
            state.turnBudget[unit.id] = { movement: 1, main: 1, minor: 1 };
        }
        state.initiative = state.combatants.filter(living).map(unit => {
            const roll = rng.d100();
            const total = roll.selected + unit.initiativeDC;
            this.event(state, 'initiative_roll', { unitId: unit.id, rawRolls: roll.rolls, selected: roll.selected, initiativeDC: unit.initiativeDC, total, rngIndex: roll.rngIndex });
            return { unitId: unit.id, total };
        }).sort((a, b) => b.total - a.total || a.unitId.localeCompare(b.unitId));
        this.saveRng(state, rng); state.cursor = 0; state.activeUnitId = state.initiative[0]?.unitId || null;
        this.event(state, 'round_started', { round: state.round, order: state.initiative });
    }

    async advanceUntilPause(state, maxActions = 1000) {
        let actions = 0;
        while (state.status === 'running' && actions < maxActions) {
            const actor = this.currentActor(state);
            if (!actor) { this.finishRound(state); continue; }
            if (actor.statuses.some(status => ['interrupted', 'stunned', 'controlled'].includes(status.id) || status.skipTurn)) { this.event(state, 'turn_skipped', { actorId: actor.id, statuses: actor.statuses.filter(status => ['interrupted', 'stunned', 'controlled'].includes(status.id) || status.skipTurn).map(status => status.id) }); state.cursor += 1; actions += 1; continue; }
            if (actor.side === 'player' && actor.state === 'dying') { this.pause(state, { type: 'player_dying', unitId: actor.id }); break; }
            if (this.shouldManualPause(state, actor)) { this.pause(state, { type: 'manual_turn', unitId: actor.id, legalActions: this.legalActions(state, actor) }); break; }
            await this.resolveAutomaticAction(state, actor); actions += 1;
            if (this.afterAction(state)) break;
        }
        if (actions >= maxActions && state.status === 'running') this.pause(state, { type: 'safety_limit', actions: maxActions });
    }

    shouldManualPause(state, actor) {
        return actor.controller === 'player' && (state.mode === 'manual' || state.mode === 'semi' && !state.strategy?.confirmed);
    }

    currentActor(state) {
        while (state.cursor < state.initiative.length) {
            const id = state.initiative[state.cursor].unitId;
            const unit = state.combatants.find(item => item.id === id);
            if (unit && living(unit)) { state.activeUnitId = id; return unit; }
            state.cursor += 1;
        }
        state.activeUnitId = null; return null;
    }

    legalActions(state, actor) {
        const targets = enemiesOf(state, actor);
        const budget = state.turnBudget?.[actor.id] || { movement: 1, main: 1, minor: 1 };
        return actor.abilities.map(ability => ({ ...ability, script: undefined, legalTargetIds: targets.filter(target => rangeLegal(state, actor, target, ability) && this.canEngage(state, actor, target, ability)).map(target => target.id), affordable: actor.ep >= ability.epCost, actionAvailable: budget[ability.actionType || 'main'] > 0, budget }));
    }

    selectTarget(state, actor) {
        const targets = enemiesOf(state, actor);
        const priorities = state.strategy?.priorities || ['nearest', 'weakest', 'boss'];
        return [...targets].sort((a, b) => {
            for (const priority of priorities) {
                const delta = priority === 'weakest' ? a.hp - b.hp : priority === 'boss' ? Number(b.boss) - Number(a.boss) : Number(a.zoneId !== actor.zoneId) - Number(b.zoneId !== actor.zoneId);
                if (delta) return delta;
            }
            return a.id.localeCompare(b.id);
        })[0];
    }

    async resolveAutomaticAction(state, actor) {
        const target = this.selectTarget(state, actor);
        if (!target) { this.event(state, 'unit_waited', { actorId: actor.id, reason: 'no_target' }); state.cursor += 1; return; }
        const available = actor.abilities.filter(ability => actor.ep >= ability.epCost && rangeLegal(state, actor, target, ability) && this.canEngage(state, actor, target, ability) && (!ability.script || this.repository.isScriptApproved(ability.scriptHash || scriptHash(ability.script), state.rulesetVersion)));
        const ability = available.find(item => item.id !== 'basic-attack') || available[0];
        if (!ability) { state.flags.noLegalAction = true; this.event(state, 'unit_waited', { actorId: actor.id, reason: 'no_legal_action' }); state.cursor += 1; return; }
        const targets = (ability.aoe || ability.targetCount > 1) ? enemiesOf(state, actor).filter(item => rangeLegal(state, actor, item, ability) && this.canEngage(state, actor, item, ability)).slice(0, ability.targetCount) : [target];
        while (!ability.aoe && targets.length > 1 && actor.ep < Math.ceil(ability.epCost * targetCostMultiplier(targets.length))) targets.pop();
        if (ability.script) { if (!await this.executeScriptAbility(state, actor, targets, ability)) return; }
        else this.resolveAttack(state, actor, targets, ability);
        state.cursor += 1;
    }

    async command(state, command) {
        this.assertWritable(state, command.expectedVersion);
        const actor = this.currentActor(state);
        if (!actor || actor.id !== command.actorId) throw httpError(409, '不是该单位的行动时机');
        if (actor.controller !== 'player') throw httpError(403, '该单位不受当前玩家控制');
        if (actor.playerId !== (command.playerId || state.playerId) || actor.seatId !== (command.seatId || state.seatId)) throw httpError(403, '当前席位没有该单位的控制权');
        const budget = state.turnBudget[actor.id] ||= { movement: 1, main: 1, minor: 1 };
        let endTurn = true;
        if (command.type === 'move') {
            if (budget.movement <= 0) throw httpError(400, '本回合移动行动已用尽');
            const zone = state.zones.find(item => item.id === command.zoneId);
            const current = state.zones.find(item => item.id === actor.zoneId);
            if (!zone || (!current?.adjacent.includes(zone.id) && zone.id !== actor.zoneId)) throw httpError(400, '目标区域不可达');
            const before = actor.zoneId; actor.zoneId = zone.id; budget.movement -= 1; endTurn = false; this.event(state, 'unit_moved', { actorId: actor.id, from: before, to: zone.id, budget });
        } else if (command.type === 'wait') { budget.movement = 0; budget.main = 0; budget.minor = 0; this.event(state, 'unit_waited', { actorId: actor.id, reason: 'player_command' }); }
        else {
            const ability = actor.abilities.find(item => item.id === (command.abilityId || 'basic-attack'));
            if (!ability) throw httpError(400, '能力不存在');
            const actionType = ability.actionType || 'main';
            if (budget[actionType] <= 0) throw httpError(400, `本回合 ${actionType} 行动已用尽`);
            const targets = (command.targetIds || []).map(id => state.combatants.find(item => item.id === id)).filter(Boolean);
            if (!targets.length) throw httpError(400, '请选择目标');
            if (targets.length > ability.targetCount) throw httpError(400, '目标数量超过能力上限');
            this.resolveAttack(state, actor, targets, ability);
            budget[actionType] -= 1;
            endTurn = !actor.abilities.some(item => budget[item.actionType || 'main'] > 0 && actor.ep >= item.epCost && enemiesOf(state, actor).some(target => rangeLegal(state, actor, target, item)));
        }
        state.status = 'running'; state.pauseReason = null; if (endTurn) state.cursor += 1;
        if (!this.afterAction(state)) await this.advanceUntilPause(state, state.mode === 'manual' ? 1000 : 10000);
    }

    resolveAttack(state, actor, targets, ability) {
        const totalEpCost = Math.ceil(ability.epCost * (ability.aoe ? 1 : targetCostMultiplier(targets.length)));
        if (actor.ep < totalEpCost) throw httpError(400, 'EP 不足');
        for (const target of targets) if (!living(target) || !rangeLegal(state, actor, target, ability) || !this.canEngage(state, actor, target, ability)) throw httpError(400, `目标 ${target.id} 无效、超出距离或接触位已满`);
        actor.ep -= totalEpCost;
        if (ability.script) throw httpError(409, '脚本能力需通过脚本命令执行');
        const rng = this.rng(state);
        const results = [];
        for (const [index, target] of targets.entries()) {
            this.recordEngagement(state, actor, target, ability);
            const roll = rng.d100(actor.statuses.some(item => item.id === 'advantage') ? 'advantage' : actor.statuses.some(item => item.id === 'disadvantage') ? 'disadvantage' : 'normal');
            const total = roll.selected + actor.attackModifier + actor.tierCorrection + ability.modifier;
            const effectiveDefenseDC = target.defenseDC + target.statuses.reduce((sum, status) => sum + Number(status.defenseBonus || 0), 0);
            const hit = total >= effectiveDefenseDC;
            let damage = null, applied = null;
            if (hit) {
                damage = damageValue(actor, target, ability, roll.selected >= 96);
                const multiplier = !ability.aoe && index > 0 ? .7 : 1;
                applied = applyDamage(target, Math.round(damage.final * multiplier));
                if (target.state !== applied.before.state) this.event(state, 'unit_state_changed', { unitId: target.id, from: applied.before.state, to: target.state });
                if (target.state === 'dying' && applied.before.state === 'active') actor.kills += 1;
                this.checkBossPhase(state, target);
            }
            const result = { targetId: target.id, rawRolls: roll.rolls, selected: roll.selected, rngIndex: roll.rngIndex, modifier: actor.attackModifier + actor.tierCorrection + ability.modifier, total, defenseDC: effectiveDefenseDC, outcome: roll.selected <= 5 ? 'disaster' : roll.selected >= 96 ? 'miracle' : hit ? 'hit' : 'miss', damage, applied };
            results.push(result); this.event(state, 'attack_check', { actorId: actor.id, abilityId: ability.id, ...result });
        }
        this.saveRng(state, rng);
        this.event(state, 'action_resolved', { actorId: actor.id, abilityId: ability.id, epCost: totalEpCost, targetCostMultiplier: ability.aoe ? 1 : targetCostMultiplier(targets.length), results });
    }

    canEngage(state, actor, target, ability) {
        if (ability.range !== 'contact') return true;
        const engaged = state.engagements?.[target.id] || [];
        const zone = state.zones.find(item => item.id === target.zoneId);
        return engaged.includes(actor.id) || engaged.length < Number(zone?.capacity || (zone?.narrow ? 3 : 6));
    }

    recordEngagement(state, actor, target, ability) {
        if (ability.range !== 'contact') return;
        const list = state.engagements[target.id] ||= [];
        if (!list.includes(actor.id)) list.push(actor.id);
    }

    async scriptCommand(state, command) {
        this.assertWritable(state, command.expectedVersion);
        const actor = this.currentActor(state);
        const ability = actor?.abilities.find(item => item.id === command.abilityId);
        if (!actor || actor.id !== command.actorId || !ability?.script) throw httpError(400, '当前脚本能力无效');
        if (actor.playerId !== (command.playerId || state.playerId) || actor.seatId !== (command.seatId || state.seatId)) throw httpError(403, '当前席位没有该单位的控制权');
        const budget = state.turnBudget[actor.id] ||= { movement: 1, main: 1, minor: 1 };
        const actionType = ability.actionType || 'main';
        if (budget[actionType] <= 0) throw httpError(400, `本回合 ${actionType} 行动已用尽`);
        const targets = (command.targetIds || []).map(id => state.combatants.find(item => item.id === id)).filter(Boolean);
        if (!await this.executeScriptAbility(state, actor, targets, ability)) return;
        budget[actionType] -= 1;
        const endTurn = !actor.abilities.some(item => budget[item.actionType || 'main'] > 0 && actor.ep >= item.epCost && enemiesOf(state, actor).some(target => rangeLegal(state, actor, target, item)));
        state.status = 'running'; state.pauseReason = null; if (endTurn) state.cursor += 1;
        if (!this.afterAction(state)) await this.advanceUntilPause(state, state.mode === 'manual' ? 1000 : 10000);
    }

    async executeScriptAbility(state, actor, targets, ability) {
        const hash = ability.scriptHash || scriptHash(ability.script);
        if (!this.repository.isScriptApproved(hash, state.rulesetVersion)) throw httpError(428, '脚本尚未审批');
        if (actor.ep < ability.epCost) throw httpError(400, 'EP 不足');
        actor.ep -= ability.epCost;
        try {
            const output = await runScript(ability.script, { ability: { ...ability, script: undefined }, actor: deepClone(actor), targets: deepClone(targets), snapshot: { round: state.round, zones: state.zones } });
            this.applyEffects(state, actor, output.effects);
            this.event(state, 'script_action_resolved', { actorId: actor.id, abilityId: ability.id, scriptHash: hash, epCost: ability.epCost, effects: output.effects });
            return true;
        } catch (error) {
            actor.ep += ability.epCost;
            this.pause(state, { type: 'script_error', actorId: actor.id, abilityId: ability.id, scriptHash: hash, error: error.message });
            return false;
        }
    }

    applyEffects(state, actor, effects) {
        for (const effect of effects) {
            const target = state.combatants.find(item => item.id === effect.targetId);
            if (effect.type === 'damage' && target) {
                const applied = applyDamage(target, Math.max(0, Math.round(effect.amount)));
                if (target.state !== applied.before.state) this.event(state, 'unit_state_changed', { unitId: target.id, from: applied.before.state, to: target.state });
                this.checkBossPhase(state, target);
            }
            else if (effect.type === 'heal' && target) { const beforeState = target.state; target.hp = Math.min(target.maxHp, target.hp + Math.max(0, Math.round(effect.amount))); if (target.hp > 0 && target.state === 'dying') target.state = 'active'; if (beforeState !== target.state) this.event(state, 'unit_state_changed', { unitId: target.id, from: beforeState, to: target.state }); }
            else if (effect.type === 'status' && target) target.statuses.push({ id: effect.status, duration: Math.max(1, Math.round(effect.duration)) });
            else if (effect.type === 'dispel' && target) target.statuses = target.statuses.filter(item => item.id !== effect.status);
            else if (effect.type === 'move' && target && state.zones.some(zone => zone.id === effect.zoneId)) target.zoneId = effect.zoneId;
            else if (effect.type === 'resource' && target && ['hp', 'ep', 'thp'].includes(effect.resource)) target[effect.resource] = Math.max(0, Math.min(effect.resource === 'ep' ? target.maxEp : effect.resource === 'hp' ? target.maxHp : Infinity, target[effect.resource] + effect.delta));
            else if (!['log'].includes(effect.type)) throw httpError(400, `脚本效果 ${effect.type} 未通过核心校验`);
            this.event(state, 'script_effect_applied', { actorId: actor.id, effect });
        }
    }

    afterAction(state) {
        const dyingPlayer = state.combatants.find(unit => unit.side === 'player' && unit.state === 'dying');
        if (dyingPlayer) { this.pause(state, { type: 'player_dying', unitId: dyingPlayer.id }); return true; }
        const winner = this.winner(state);
        if (winner) { this.complete(state, winner); return true; }
        if (state.pendingReaction) { this.pause(state, { type: 'reaction_window', ...state.pendingReaction }); return true; }
        if (state.mode === 'semi') {
            const triggers = evaluateTriggers(state);
            if (triggers.length) { this.pause(state, { type: 'takeover_trigger', triggers }); return true; }
        }
        return false;
    }

    finishRound(state) {
        const progress = sha256(state.combatants.map(unit => [unit.id, unit.hp, unit.thp, unit.ep, unit.zoneId, unit.state, unit.statuses, unit.reachedPhases]));
        state.noChangeRounds = progress === state.lastProgressHash ? state.noChangeRounds + 1 : 0; state.lastProgressHash = progress;
        this.event(state, 'round_completed', { round: state.round, progressHash: progress, noChangeRounds: state.noChangeRounds });
        if (state.noChangeRounds >= 10) return this.pause(state, { type: 'stalemate', rounds: 10 });
        if (state.round >= 200) return this.pause(state, { type: 'round_limit', rounds: 200 });
        this.beginRound(state);
    }

    checkBossPhase(state, target) {
        if (!target.boss || target.state !== 'active') return;
        const percent = target.hp / target.maxHp * 100;
        for (const threshold of target.phases) if (percent <= threshold && !target.reachedPhases.includes(threshold)) {
            target.reachedPhases.push(threshold); state.flags.bossPhaseChanged = true;
            state.pendingReaction = { type: 'boss_phase', unitId: target.id, threshold, options: ['interrupt', 'defend', 'policy'] };
            this.event(state, 'boss_phase_changed', { unitId: target.id, threshold, hpPercent: percent });
        }
    }

    winner(state) {
        const playerActive = state.combatants.some(unit => unit.side === 'player' && living(unit));
        const enemyActive = state.combatants.some(unit => unit.side === 'enemy' && living(unit));
        if (!enemyActive) return 'player';
        if (!playerActive) return 'enemy';
        return null;
    }

    complete(state, winner) {
        state.status = 'completed'; state.activeUnitId = null; state.pauseReason = null;
        const events = [...this.repository.events(state.id), ...state.pendingEvents];
        const finalSnapshot = { combatants: deepClone(state.combatants), zones: deepClone(state.zones), round: state.round };
        const protagonist = state.combatants.find(unit => unit.side === 'player' && unit.controller === 'player') || state.combatants.find(unit => unit.side === 'player');
        state.finalResult = {
            battleId: state.id, winner, rulesetVersion: state.rulesetVersion, seed: state.seed, initialHash: state.initialHash,
            eventHash: events.at(-1)?.hash || null, rounds: state.round, initialState: state.initialSnapshot, finalState: finalSnapshot,
            casualties: state.combatants.filter(unit => unit.state !== 'active').map(unit => ({ id: unit.id, name: unit.name, side: unit.side, state: unit.state })),
            keyEvents: events.filter(event => ['attack_check', 'unit_state_changed', 'boss_phase_changed', 'player_dying'].includes(event.type)).slice(-100),
            checkResults: events.filter(event => event.type === 'attack_check').map(event => event.payload),
            mvuPatch: protagonist ? [
                { op: 'replace', path: '/stat_data/系统状态/是否战斗中', value: false },
                { op: 'replace', path: '/stat_data/系统状态/当前轮次', value: state.round },
                { op: 'replace', path: '/stat_data/主角/HP', value: protagonist.hp },
                { op: 'replace', path: '/stat_data/主角/EP', value: protagonist.ep },
            ] : [],
            narrativeAnchors: this.buildNarrativeAnchors(events),
        };
        this.event(state, 'combat_completed', { winner, rounds: state.round, resultHash: sha256({ winner, rounds: state.round, seed: state.seed, initialHash: state.initialHash, finalState: finalSnapshot, casualties: state.finalResult.casualties, checkResults: state.finalResult.checkResults }) });
    }

    buildNarrativeAnchors(events) {
        return events.filter(event => ['round_started', 'attack_check', 'boss_phase_changed', 'unit_state_changed'].includes(event.type)).slice(-200).map(event => ({ sequence: event.sequence, round: event.round, type: event.type, data: event.payload }));
    }

    pause(state, reason) { state.status = 'paused'; state.pauseReason = reason; this.event(state, 'combat_paused', reason); }
    async resume(state) { this.assertWritable(state); state.status = 'running'; state.pauseReason = null; this.event(state, 'combat_resumed'); await this.advanceUntilPause(state, state.mode === 'manual' ? 1000 : 10000); }
    async reaction(state, input = {}) {
        this.assertWritable(state);
        if (!state.pendingReaction) throw httpError(409, '当前没有反应窗口');
        const reaction = state.pendingReaction;
        const actor = state.combatants.find(unit => unit.side === 'player' && unit.controller === 'player' && living(unit)) || state.combatants.find(unit => unit.side === 'player' && living(unit));
        const target = state.combatants.find(unit => unit.id === reaction.unitId);
        const choice = input.choice === 'policy' ? (state.strategy?.reactionPolicy === 'conserve' ? 'defend' : 'interrupt') : input.choice;
        if (choice === 'defend' && actor) actor.statuses.push({ id: 'reaction_defend', name: '反应防御', defenseBonus: 10, duration: 2 });
        if (choice === 'interrupt' && actor && target) {
            const rng = this.rng(state); const roll = rng.d100(); const total = roll.selected + actor.attackModifier + actor.tierCorrection; const dc = 100 + target.tierCorrection;
            if (total >= dc) target.statuses.push({ id: 'interrupted', name: '被打断', duration: 1 });
            this.saveRng(state, rng); this.event(state, 'reaction_check', { actorId: actor.id, targetId: target.id, choice, rawRolls: roll.rolls, selected: roll.selected, modifier: actor.attackModifier + actor.tierCorrection, total, dc, success: total >= dc, rngIndex: roll.rngIndex });
        }
        state.pendingReaction = null; this.event(state, 'reaction_resolved', { choice, source: input.choice || 'policy', reaction });
        await this.resume(state);
    }
    setControl(state, input) { const unit = state.combatants.find(item => item.id === input.unitId); if (!unit || unit.side !== 'player') throw httpError(400, '只能切换玩家方单位'); unit.controller = input.controller === 'ai' ? 'ai' : 'player'; unit.playerId = input.playerId || unit.playerId; unit.seatId = input.seatId || unit.seatId; this.event(state, 'control_changed', { unitId: unit.id, controller: unit.controller, playerId: unit.playerId, seatId: unit.seatId }); }
    setMode(state, mode) { if (!MODES.has(mode)) throw httpError(400, '控制模式无效'); state.mode = mode; this.event(state, 'mode_changed', { mode }); }
    rng(state) { return new DeterministicRng(state.seed, state.rng.state, state.rng.index); }
    saveRng(state, rng) { state.rng = rng.snapshot(); }
}

export function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
