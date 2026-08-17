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
            CREATE TABLE IF NOT EXISTS combat_asset_profiles (
                asset_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                kind TEXT NOT NULL, profile_json TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
        `);
        // Simulator runs deliberately stay in process memory.  They retain the
        // same immutable event ledger and command idempotency as real battles,
        // but never acquire a row in combat.sqlite or a story-session link.
        this.transient = new Map();
        this.insertSession = this.db.prepare('INSERT INTO combat_sessions VALUES (@id,@storySessionId,@status,@version,@rulesetVersion,@seed,@stateJson,@createdAt,@updatedAt)');
        this.updateSession = this.db.prepare('UPDATE combat_sessions SET status=@status,version=@version,state_json=@stateJson,updated_at=@updatedAt WHERE id=@id');
    }

    create(state) {
        if (state.transient) {
            this.transient.set(state.id, { state, events: [], commands: new Map() });
            return state;
        }
        const now = new Date().toISOString();
        this.insertSession.run({ id: state.id, storySessionId: state.storySessionId || null, status: state.status, version: state.version, rulesetVersion: state.rulesetVersion, seed: state.seed, stateJson: JSON.stringify(state), createdAt: now, updatedAt: now });
        return state;
    }

    get(id) {
        const transient = this.transient.get(id);
        if (transient) return JSON.parse(JSON.stringify(transient.state));
        const row = this.db.prepare('SELECT state_json FROM combat_sessions WHERE id=?').get(id);
        return row ? JSON.parse(row.state_json) : null;
    }

    save(state) {
        const transient = this.transient.get(state.id);
        if (transient) { transient.state = JSON.parse(JSON.stringify(state)); return; }
        this.updateSession.run({ id: state.id, status: state.status, version: state.version, stateJson: JSON.stringify(state), updatedAt: new Date().toISOString() });
    }

    transaction(run) { return this.db.transaction(run)(); }

    appendEvent(battleId, event) {
        const transient = this.transient.get(battleId);
        if (transient) { transient.events.push(JSON.parse(JSON.stringify(event))); return; }
        this.db.prepare('INSERT INTO combat_events VALUES (?,?,?,?)').run(battleId, event.sequence, JSON.stringify(event), event.hash);
    }

    events(id, after = 0) {
        const transient = this.transient.get(id);
        if (transient) return transient.events.filter(event => event.sequence > (Number(after) || 0)).map(event => JSON.parse(JSON.stringify(event)));
        return this.db.prepare('SELECT event_json FROM combat_events WHERE battle_id=? AND sequence>? ORDER BY sequence').all(id, Number(after) || 0).map(row => JSON.parse(row.event_json));
    }

    command(id, commandId) {
        const transient = this.transient.get(id);
        if (transient) return transient.commands.has(commandId) ? JSON.parse(JSON.stringify(transient.commands.get(commandId))) : null;
        const row = this.db.prepare('SELECT result_json FROM combat_commands WHERE battle_id=? AND command_id=?').get(id, commandId);
        return row ? JSON.parse(row.result_json) : null;
    }

    saveCommand(id, commandId, result) {
        const transient = this.transient.get(id);
        if (transient) { transient.commands.set(commandId, JSON.parse(JSON.stringify(result))); return; }
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

    assetProfile(assetId) {
        const row = this.db.prepare('SELECT profile_json FROM combat_asset_profiles WHERE asset_id=?').get(assetId);
        return row ? JSON.parse(row.profile_json) : null;
    }

    saveAssetProfile(profile) {
        if (!profile?.assetId) return;
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO combat_asset_profiles(asset_id,fingerprint,kind,profile_json,created_at,updated_at)
            VALUES (@assetId,@fingerprint,@kind,@profileJson,@now,@now)
            ON CONFLICT(asset_id) DO UPDATE SET fingerprint=excluded.fingerprint,kind=excluded.kind,profile_json=excluded.profile_json,updated_at=excluded.updated_at`)
            .run({ assetId: String(profile.assetId), fingerprint: String(profile.fingerprint || ''), kind: String(profile.kind || 'unknown'), profileJson: JSON.stringify(profile), now });
    }
}
