import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CombatRepository } from '../combat/repository.js';
import { CombatEngine } from '../combat/engine.js';
import { compileStrategy } from '../combat/strategy.js';
import { runScript, scriptHash, testScript } from '../combat/sandbox.js';
import { checkOutcome, QUALITY_DC, targetCostMultiplier } from '../combat/rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test', 'vibe-combat');
fs.mkdirSync(root, { recursive: true });
const dbPath = path.join(root, 'data', 'combat.sqlite');
for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${dbPath}${suffix}`)) fs.rmSync(`${dbPath}${suffix}`);
const repository = new CombatRepository(root);
const engine = new CombatEngine(repository);
assert.equal(QUALITY_DC.SSS, 280); assert.equal(checkOutcome(98, 10, 999), 'miracle'); assert.equal(checkOutcome(2, 999, 1), 'disaster'); assert.equal(targetCostMultiplier(5), 3);

function reload(id) { const state = repository.get(id); state.pendingEvents = []; return state; }
function commit(state) { state.version += 1; const events = state.pendingEvents.splice(0); repository.commit(state, events); return state; }
function baseUnit(side, extra = {}) { return { id: side, name: side, side, controller: side === 'enemy' ? 'ai' : 'player', hp: 100, maxHp: 100, attack: 20, attackModifier: 100, defenseDC: 50, zoneId: 'arena', ...extra }; }
function payload(seed, combatants, mode = 'auto') { return { seed, mode, encounter: { title: 'test', zones: [{ id: 'arena', name: 'arena', adjacent: [], capacity: 6 }], combatants } }; }
async function run(id) { const state = reload(id); await engine.start(state); commit(state); return state; }

// Same seed/input produces the same deterministic chain even though battle IDs/timestamps differ.
const deterministicPayload = payload('fixed-seed', [baseUnit('player', { controller: 'ai' }), baseUnit('enemy')]);
const first = await run(engine.create(deterministicPayload).id);
const second = await run(engine.create(deterministicPayload).id);
assert.equal(first.lastEventHash, second.lastEventHash, 'deterministic event hashes differ');

// Manual mode stops exactly at the controlled unit and advances through an explicit command.
let manual = reload(engine.create(payload('manual', [baseUnit('player'), baseUnit('enemy', { attackModifier: -100 })], 'manual')).id);
await engine.start(manual); assert.equal(manual.status, 'paused'); assert.equal(manual.pauseReason.type, 'manual_turn');
const versionBefore = manual.version;
await engine.command(manual, { expectedVersion: versionBefore, type: 'attack', actorId: manual.activeUnitId, targetIds: ['enemy'], abilityId: 'basic-attack' });
assert.ok(manual.sequence > 3); commit(manual);

// A manual turn preserves the actor after movement, then consumes the main action.
let tactical = reload(engine.create({ seed: 'movement-budget', mode: 'manual', encounter: { zones: [{ id: 'rear', name: 'rear', adjacent: ['front'] }, { id: 'front', name: 'front', adjacent: ['rear'] }], combatants: [baseUnit('player', { zoneId: 'rear', initiativeDC: 1000 }), baseUnit('enemy', { zoneId: 'front', attackModifier: -100 })] } }).id);
await engine.start(tactical); const tacticalActor = tactical.activeUnitId;
await engine.command(tactical, { type: 'move', actorId: tacticalActor, zoneId: 'front' });
assert.equal(tactical.activeUnitId, tacticalActor); assert.equal(tactical.status, 'paused'); assert.equal(tactical.turnBudget[tacticalActor].movement, 0);
await engine.command(tactical, { type: 'attack', actorId: tacticalActor, abilityId: 'basic-attack', targetIds: ['enemy'] }); commit(tactical);

// 100 zombies retain individual IDs but an AOE is processed as one deterministic action.
const massStart = performance.now();
let mass = reload(engine.create(payload('100-zombies', [baseUnit('player', { controller: 'ai', hp: 1000, maxHp: 1000, abilities: [{ id: 'purge', name: '横扫', type: 'true', power: 100, range: 'contact', targetCount: 100, aoe: true }] }), baseUnit('enemy', { name: '丧尸', count: 100, hp: 20, maxHp: 20, attackModifier: -100 })])).id);
await engine.start(mass); commit(mass);
const massMs = performance.now() - massStart;
assert.equal(mass.combatants.filter(unit => unit.side === 'enemy').length, 100);
assert.equal(mass.status, 'completed'); assert.equal(mass.finalResult.winner, 'player');
assert.ok(massMs < 1000, '100 zombie scenario exceeded 1s test budget');

const thousandStart = performance.now();
let thousand = reload(engine.create(payload('1000-hostiles', [baseUnit('player', { controller: 'ai', hp: 1000, maxHp: 1000, abilities: [{ id: 'wide-area', name: '大范围清扫', type: 'true', power: 100, range: 'far', targetCount: 1000, aoe: true }] }), baseUnit('enemy', { name: '压力实体', count: 1000, hp: 10, maxHp: 10, attackModifier: -100 })])).id);
await engine.start(thousand); commit(thousand); const thousandMs = performance.now() - thousandStart;
assert.equal(thousand.status, 'completed'); assert.equal(thousand.combatants.filter(unit => unit.side === 'enemy').length, 1000); assert.ok(thousandMs < 3000, '1000 unit scenario exceeded 3s test budget');

// Boss phases and mixed boss + cohort bookkeeping.
let mixed = reload(engine.create(payload('boss-plus-mobs', [baseUnit('player', { controller: 'ai', hp: 1000, maxHp: 1000, attack: 35 }), baseUnit('enemy', { id: 'boss', name: 'Boss', boss: true, hp: 120, maxHp: 120, armor: 0, attackModifier: -100 }), baseUnit('enemy', { id: 'minion', name: '小兵', count: 12, hp: 10, maxHp: 10, attackModifier: -100 })])).id);
await engine.start(mixed);
while (mixed.status === 'paused' && mixed.pauseReason?.type === 'reaction_window') await engine.reaction(mixed, { choice: 'defend' });
commit(mixed);
assert.equal(mixed.combatants.filter(unit => unit.boss).length, 1);
assert.equal(mixed.combatants.filter(unit => unit.templateId === 'minion').length, 12);
assert.ok(repository.events(mixed.id).some(event => event.type === 'boss_phase_changed'));

// Strategy trigger compiler and local takeover.
const strategy = compileStrategy('优先集火 Boss，HP 低于 35% 或击杀 60% 敌人时接管，保留 25% EP。', { confirmed: true });
assert.equal(strategy.confirmed, true); assert.ok(strategy.takeoverTriggers.some(item => item.value === 35)); assert.ok(strategy.takeoverTriggers.some(item => item.value === 60));

// QuickJS capability sandbox returns declarations only; forbidden host access is rejected.
const sandboxSource = 'api.damage(input.targets[0].id, 12, "true"); api.status(input.targets[0].id, "stunned", 1);';
const sandboxResult = await runScript(sandboxSource, { ability: { id: 'sandbox', name: '沙箱能力' }, actor: { id: 'actor' }, targets: [{ id: 'target' }] });
assert.equal(sandboxResult.effects.length, 2); assert.equal(sandboxResult.effects[0].amount, 12);
const sandboxTests = await testScript(sandboxSource, { id: 'sandbox', name: '沙箱能力' }); assert.equal(sandboxTests.passed, true);
await assert.rejects(() => runScript('fetch("https://example.com")', { ability: {}, actor: {}, targets: [] }), /禁止能力/);

// Approved scripts also execute in automatic mode; approval is keyed by source + ruleset.
let scripted = reload(engine.create(payload('script-auto', [baseUnit('player', { controller: 'ai', abilities: [{ id: 'script-hit', name: '脚本打击', type: 'true', range: 'contact', script: 'api.damage(input.targets[0].id, 200, "true");' }] }), baseUnit('enemy', { attackModifier: -100 })])).id);
await engine.start(scripted); assert.equal(scripted.status, 'awaiting_script_approval');
const approvedHash = scriptHash(scripted.combatants[0].abilities.find(item => item.id === 'script-hit').script);
repository.approveScript(approvedHash, scripted.rulesetVersion, { test: true }); scripted.status = 'ready'; scripted.pauseReason = null;
await engine.start(scripted); commit(scripted); assert.equal(scripted.status, 'completed'); assert.ok(repository.events(scripted.id).some(event => event.type === 'script_action_resolved'));

// Every ledger is a valid hash chain and replay state retains RNG position.
for (const state of [first, second, manual, tactical, mass, thousand, mixed, scripted]) {
    const events = repository.events(state.id); assert.ok(events.length > 0);
    for (let index = 1; index < events.length; index += 1) assert.equal(events[index].previousHash, events[index - 1].hash);
    assert.ok(state.rng.index > 0);
}

console.log(JSON.stringify({ ok: true, deterministicHash: first.lastEventHash, massMs: Math.round(massMs), massEvents: repository.events(mass.id).length, thousandMs: Math.round(thousandMs), thousandEvents: repository.events(thousand.id).length, mixedRounds: mixed.round, mixedEvents: repository.events(mixed.id).length }, null, 2));
