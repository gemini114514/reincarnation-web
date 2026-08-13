import crypto from 'node:crypto';

export const RULESET_VERSION = 'vibe-combat-v1/rules-v3.2.6';

export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export function sha256(value) {
    return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

export function makeId(prefix = '') {
    return `${prefix}${crypto.randomUUID()}`;
}

export function seed256(value) {
    const source = String(value || crypto.randomBytes(32).toString('hex'));
    return /^[a-f0-9]{64}$/i.test(source) ? source.toLowerCase() : sha256(source);
}

// xoshiro128**; state and draw index are persisted so reload/replay never rerolls.
export class DeterministicRng {
    constructor(seed, state, index = 0) {
        const bytes = Buffer.from(seed256(seed), 'hex');
        this.state = state?.length === 4 ? state.map(Number) : [0, 4, 8, 12].map(offset => bytes.readUInt32LE(offset));
        if (this.state.every(value => value === 0)) this.state[0] = 1;
        this.index = Number(index) || 0;
    }

    nextUint32() {
        const s = this.state;
        const result = Math.imul(((Math.imul(s[1], 5) << 7) | (Math.imul(s[1], 5) >>> 25)) >>> 0, 9) >>> 0;
        const t = (s[1] << 9) >>> 0;
        s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
        s[3] = ((s[3] << 11) | (s[3] >>> 21)) >>> 0;
        this.state = s.map(value => value >>> 0);
        this.index += 1;
        return result;
    }

    int(min, max) {
        return min + (this.nextUint32() % (max - min + 1));
    }

    d100(mode = 'normal') {
        const rolls = [this.int(1, 100)];
        if (mode === 'advantage' || mode === 'disadvantage') rolls.push(this.int(1, 100));
        return { rolls, selected: mode === 'advantage' ? Math.max(...rolls) : mode === 'disadvantage' ? Math.min(...rolls) : rolls[0], mode, rngIndex: this.index };
    }

    snapshot() { return { state: [...this.state], index: this.index }; }
}

export function deepClone(value) { return structuredClone(value); }

