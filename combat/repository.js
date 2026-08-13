import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export class CombatRepository {
    constructor(root) {
        const dataDir = path.join(root, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        this.db = new Database(path.join(dataDir, 'combat.sqlite'));
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS combat_sessions (
                id TEXT PRIMARY KEY, story_session_id TEXT, status TEXT NOT NULL,
                version INTEGER NOT NULL, ruleset_version TEXT NOT NULL,
                seed TEXT NOT NULL, state_json TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS combat_events (
                battle_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                event_json TEXT NOT NULL, hash TEXT NOT NULL,
                PRIMARY KEY (battle_id, sequence),
                FOREIGN KEY (battle_id) REFERENCES combat_sessions(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS combat_commands (
                battle_id TEXT NOT NULL, command_id TEXT NOT NULL,
                result_json TEXT NOT NULL, created_at TEXT NOT NULL,
                PRIMARY KEY (battle_id, command_id)
            );
            CREATE TABLE IF NOT EXISTS combat_script_approvals (
                script_hash TEXT NOT NULL, ruleset_version TEXT NOT NULL,
                source_json TEXT NOT NULL, approved_at TEXT NOT NULL,
                PRIMARY KEY (script_hash, ruleset_version)
            );
        `);
        this.insertSession = this.db.prepare('INSERT INTO combat_sessions VALUES (@id,@storySessionId,@status,@version,@rulesetVersion,@seed,@stateJson,@createdAt,@updatedAt)');
        this.updateSession = this.db.prepare('UPDATE combat_sessions SET status=@status,version=@version,state_json=@stateJson,updated_at=@updatedAt WHERE id=@id');
    }

    create(state) {
        const now = new Date().toISOString();
        this.insertSession.run({ id: state.id, storySessionId: state.storySessionId || null, status: state.status, version: state.version, rulesetVersion: state.rulesetVersion, seed: state.seed, stateJson: JSON.stringify(state), createdAt: now, updatedAt: now });
        return state;
    }

    get(id) {
        const row = this.db.prepare('SELECT state_json FROM combat_sessions WHERE id=?').get(id);
        return row ? JSON.parse(row.state_json) : null;
    }

    save(state) {
        this.updateSession.run({ id: state.id, status: state.status, version: state.version, stateJson: JSON.stringify(state), updatedAt: new Date().toISOString() });
    }

    transaction(run) { return this.db.transaction(run)(); }

    appendEvent(battleId, event) {
        this.db.prepare('INSERT INTO combat_events VALUES (?,?,?,?)').run(battleId, event.sequence, JSON.stringify(event), event.hash);
    }

    events(id, after = 0) {
        return this.db.prepare('SELECT event_json FROM combat_events WHERE battle_id=? AND sequence>? ORDER BY sequence').all(id, Number(after) || 0).map(row => JSON.parse(row.event_json));
    }

    command(id, commandId) {
        const row = this.db.prepare('SELECT result_json FROM combat_commands WHERE battle_id=? AND command_id=?').get(id, commandId);
        return row ? JSON.parse(row.result_json) : null;
    }

    saveCommand(id, commandId, result) {
        this.db.prepare('INSERT INTO combat_commands VALUES (?,?,?,?)').run(id, commandId, JSON.stringify(result), new Date().toISOString());
    }

    commit(state, events = [], commandId = null, result = null) {
        this.db.transaction(() => {
            this.save(state);
            for (const event of events) this.appendEvent(state.id, event);
            if (commandId) this.saveCommand(state.id, commandId, result);
        })();
    }

    approveScript(hash, rulesetVersion, source) {
        this.db.prepare('INSERT OR REPLACE INTO combat_script_approvals VALUES (?,?,?,?)').run(hash, rulesetVersion, JSON.stringify(source), new Date().toISOString());
    }

    isScriptApproved(hash, rulesetVersion) {
        return Boolean(this.db.prepare('SELECT 1 ok FROM combat_script_approvals WHERE script_hash=? AND ruleset_version=?').get(hash, rulesetVersion));
    }
}
