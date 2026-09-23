export class McpSessionRegistry {
    sessions = new Map();
    reservations = new Map();
    now;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
    }
    get size() {
        return this.sessions.size;
    }
    reserve(maxSessions, replacementFor) {
        const pending = this.reservations.size;
        const hasCapacity = this.sessions.size + pending < maxSessions;
        const canReplace = replacementFor !== undefined &&
            this.sessions.size + pending === maxSessions &&
            this.sessions.has(replacementFor) &&
            ![...this.reservations.values()].some((reservation) => reservation.replacementFor === replacementFor);
        if (!hasCapacity && !canReplace)
            return undefined;
        const token = {};
        this.reservations.set(token, { maxSessions, replacementFor });
        return token;
    }
    release(reservation) {
        return this.reservations.delete(reservation);
    }
    register(sessionId, transport, reservation) {
        if (reservation !== undefined) {
            const details = this.reservations.get(reservation);
            if (!details)
                return false;
            this.reservations.delete(reservation);
            if ((details.replacementFor !== undefined && this.sessions.has(details.replacementFor)) ||
                this.sessions.size >= details.maxSessions) {
                return false;
            }
        }
        this.sessions.set(sessionId, {
            transport,
            lastActivityAt: this.now(),
            activityVersion: 0,
        });
        return true;
    }
    get(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return undefined;
        entry.lastActivityAt = this.now();
        entry.activityVersion += 1;
        return entry.transport;
    }
    remove(sessionId) {
        return this.sessions.delete(sessionId);
    }
    async closeIdle(idleTimeoutMs) {
        const cutoff = this.now() - idleTimeoutMs;
        const idleSessions = [];
        for (const [sessionId, entry] of this.sessions) {
            if (entry.lastActivityAt > cutoff)
                continue;
            this.sessions.delete(sessionId);
            idleSessions.push({ sessionId, transport: entry.transport });
        }
        return closeSessions(idleSessions);
    }
    async closeAll() {
        this.reservations.clear();
        const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
            sessionId,
            transport: entry.transport,
        }));
        this.sessions.clear();
        return closeSessions(sessions);
    }
}
async function closeSessions(sessions) {
    return Promise.all(sessions.map(async ({ sessionId, transport }) => {
        try {
            await transport.close();
            return { sessionId };
        }
        catch (error) {
            return { sessionId, error };
        }
    }));
}
