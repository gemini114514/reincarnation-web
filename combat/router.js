import express from 'express';
import { CombatEngine, httpError } from './engine.js';
import { CombatRepository } from './repository.js';
import { inspectScript, testScript } from './sandbox.js';
import { compileStrategy } from './strategy.js';
import { deepClone, sha256 } from './util.js';

export function createCombatRouter(root) {
    const router = express.Router();
    const repository = new CombatRepository(root);
    const engine = new CombatEngine(repository);
    const locks = new Map();

    const locked = (id, run) => {
        const previous = locks.get(id) || Promise.resolve();
        const current = previous.catch(() => {}).then(run);
        const tracked = current.catch(() => {}).finally(() => { if (locks.get(id) === tracked) locks.delete(id); });
        locks.set(id, tracked);
        return current;
    };

    const get = id => {
        const state = repository.get(id);
        if (!state) throw httpError(404, '战斗不存在');
        state.pendingEvents = [];
        return state;
    };

    const commit = (state, commandId = null) => {
        state.version += 1;
        const events = state.pendingEvents.splice(0);
        const result = engine.publicState(state);
        repository.commit(state, events, commandId, result);
        return result;
    };

    const mutate = (handler, { allowCompleted = false } = {}) => async (req, res, next) => {
        try {
            const result = await locked(req.params.id, async () => {
                const commandId = req.body.commandId || null;
                if (commandId) {
                    const cached = repository.command(req.params.id, commandId);
                    if (cached) return cached;
                }
                const state = get(req.params.id);
                if (allowCompleted) {
                    if (req.body.expectedVersion !== undefined && Number(req.body.expectedVersion) !== state.version) throw httpError(409, `状态版本冲突：当前为 ${state.version}`);
                } else engine.assertWritable(state, req.body.expectedVersion);
                await handler(state, req.body, req);
                return commit(state, commandId);
            });
            res.json(result);
        } catch (error) { next(error); }
    };

    router.post('/sessions', (req, res, next) => {
        try { res.status(201).json(engine.create(req.body)); } catch (error) { next(error); }
    });
    router.get('/:id', (req, res, next) => { try { res.json(engine.publicState(get(req.params.id))); } catch (error) { next(error); } });
    router.get('/:id/events', (req, res, next) => { try { get(req.params.id); res.json({ events: repository.events(req.params.id, req.query.after) }); } catch (error) { next(error); } });
    router.get('/:id/replay', (req, res, next) => {
        try {
            const state = get(req.params.id); const events = repository.events(state.id);
            res.json({ format: 'vibe-combat-replay', version: 1, battleId: state.id, rulesetVersion: state.rulesetVersion, seed: state.seed, initialSnapshot: state.initialSnapshot, initialHash: state.initialHash, events, finalResult: state.finalResult, replayHash: sha256({ initial: state.initialHash, events: events.map(event => event.hash), final: state.finalResult }) });
        } catch (error) { next(error); }
    });
    router.post('/:id/strategy/compile', mutate((state, body) => {
        state.strategy = compileStrategy(body.text, body);
        if (body.mode) engine.setMode(state, body.mode);
        engine.event(state, 'strategy_compiled', { strategy: state.strategy });
    }));
    router.post('/:id/scripts/inspect', async (req, res, next) => { try { get(req.params.id); res.json(await testScript(req.body.source, req.body.ability)); } catch (error) { next(error); } });
    router.post('/:id/scripts/:hash/approve', mutate((state, body, req) => {
        const inspection = inspectScript(body.source, body.ability);
        if (inspection.hash !== req.params.hash) throw httpError(400, '脚本哈希与源码不一致');
        repository.approveScript(inspection.hash, state.rulesetVersion, { inspection, source: body.source });
        if (!state.approvedScripts.includes(inspection.hash)) state.approvedScripts.push(inspection.hash);
        state.status = 'ready'; state.pauseReason = null; engine.event(state, 'script_approved', { hash: inspection.hash, ability: body.ability });
    }));
    router.post('/:id/start', mutate(async (state, body) => { if (body.mode) engine.setMode(state, body.mode); await engine.start(state); }));
    router.post('/:id/commands', mutate(async (state, body) => body.type === 'script' ? engine.scriptCommand(state, body) : engine.command(state, body)));
    router.post('/:id/reactions', mutate(async (state, body) => engine.reaction(state, body)));
    router.post('/:id/advance', mutate(async (state, body) => {
        if (body.mode) engine.setMode(state, body.mode);
        if (state.status === 'paused') { state.status = 'running'; state.pauseReason = null; }
        await engine.advanceUntilPause(state, Math.min(10000, Math.max(1, Number(body.maxActions) || 1000)));
    }));
    router.post('/:id/control', mutate((state, body) => { if (body.mode) engine.setMode(state, body.mode); if (body.unitId) engine.setControl(state, body); }));
    router.post('/:id/pause', mutate((state, body) => engine.pause(state, { type: 'user', note: body.note || '' })));
    router.post('/:id/resume', mutate(async state => engine.resume(state)));
    router.post('/:id/finalize', mutate(state => {
        if (state.status !== 'completed') throw httpError(409, '只有已完成战斗可以结算');
        if (!state.finalizedAt) { state.finalizedAt = new Date().toISOString(); engine.event(state, 'combat_finalized', { resultHash: sha256(state.finalResult) }); }
    }, { allowCompleted: true }));
    router.post('/:id/abandon', mutate((state, body) => { state.status = 'abandoned'; state.pauseReason = { type: 'abandoned', note: body.note || '' }; engine.event(state, 'combat_abandoned', state.pauseReason); }));
    router.get('/:id/narrative-bundle', (req, res, next) => {
        try {
            const state = get(req.params.id);
            if (!state.finalResult && state.status !== 'paused') throw httpError(409, '尚无正式暂停点或最终战果');
            const events = repository.events(state.id);
            const bundle = state.finalResult || { battleId: state.id, paused: true, pauseReason: state.pauseReason, rounds: state.round, finalState: { combatants: deepClone(state.combatants), zones: deepClone(state.zones) }, narrativeAnchors: engine.buildNarrativeAnchors(events), seed: state.seed, eventHash: events.at(-1)?.hash };
            res.json({ bundle, systemPrompt: '你是《轮回战场》的战斗叙事融合器。只能依据 BattleResultBundle 写紧凑连贯的中文战斗剧情，不得修改命中、伤害、死亡、资源、位置或胜负。不要输出 UpdateVariable。', userPrompt: `请将以下本地权威战报融合为完整剧情：\n${JSON.stringify(bundle)}` });
        } catch (error) { next(error); }
    });

    router.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    return { router, repository, engine };
}
