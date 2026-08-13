import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createCombatRouter } from '../combat/router.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test', 'vibe-combat-api');
fs.mkdirSync(root, { recursive: true });
const db = path.join(root, 'data', 'combat.sqlite');
for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(`${db}${suffix}`)) fs.rmSync(`${db}${suffix}`);
const app = express(); app.use(express.json()); app.use('/api/combat', createCombatRouter(root).router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/combat`;
const request = async (route, options = {}) => { const response = await fetch(`${base}${route}`, { headers: { 'Content-Type': 'application/json' }, ...options }); const body = await response.json(); return { response, body }; };

try {
    const created = await request('/sessions', { method: 'POST', body: JSON.stringify({ seed: 'api-seed', mode: 'manual', storySessionId: 'story-1', encounter: { title: 'API test', combatants: [{ id: 'p', name: 'P', side: 'player', hp: 100, maxHp: 100, attack: 100, attackModifier: 100 }, { id: 'e', name: 'E', side: 'enemy', hp: 10, maxHp: 10, attackModifier: -100 }] } }) });
    assert.equal(created.response.status, 201); const battle = created.body;
    const commandId = 'start-idempotent';
    const started = await request(`/${battle.id}/start`, { method: 'POST', body: JSON.stringify({ commandId, expectedVersion: battle.version }) });
    assert.equal(started.response.status, 200); assert.equal(started.body.status, 'paused');
    const repeated = await request(`/${battle.id}/start`, { method: 'POST', body: JSON.stringify({ commandId, expectedVersion: battle.version }) });
    assert.equal(repeated.response.status, 200); assert.equal(repeated.body.version, started.body.version);
    const conflict = await request(`/${battle.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'stale', expectedVersion: battle.version, type: 'wait', actorId: started.body.activeUnitId }) });
    assert.equal(conflict.response.status, 409);
    const action = await request(`/${battle.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'hit', expectedVersion: started.body.version, type: 'attack', actorId: started.body.activeUnitId, abilityId: 'basic-attack', targetIds: ['e'] }) });
    assert.equal(action.response.status, 200); assert.equal(action.body.status, 'completed');
    const replay = await request(`/${battle.id}/replay`); assert.equal(replay.response.status, 200); assert.ok(replay.body.replayHash); assert.ok(replay.body.events.length > 3);
    const narrative = await request(`/${battle.id}/narrative-bundle`); assert.equal(narrative.response.status, 200); assert.equal(narrative.body.bundle.winner, 'player');
    const finalized = await request(`/${battle.id}/finalize`, { method: 'POST', body: JSON.stringify({ commandId: 'finalize', expectedVersion: action.body.version }) }); assert.equal(finalized.response.status, 200); assert.ok(finalized.body.finalizedAt);
    console.log(JSON.stringify({ ok: true, battleId: battle.id, eventCount: replay.body.events.length, replayHash: replay.body.replayHash }, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); }
