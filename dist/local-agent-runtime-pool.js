import { createHash } from "node:crypto";
import { Result } from "better-result";
import { AgentProviderUnavailableError, } from "./local-agent-errors.js";
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60_000;
/**
 * Owns live provider resources, not logical agent identity. Acquisition is
 * single-flight per runtime key and an entry is removed before its close
 * begins, so a new caller can never race with a closing runtime.
 */
export class LocalAgentRuntimePool {
    entries = new Map();
    now;
    logger;
    sessionIdleTimeoutMs;
    closing = false;
    closePromise;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
        this.logger = options.logger;
        this.sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
        if (!Number.isFinite(this.sessionIdleTimeoutMs) || this.sessionIdleTimeoutMs < 0) {
            throw new Error("Local agent session idle timeout must be a non-negative finite duration.");
        }
    }
    async run(driver, context, input, inputCallbacks) {
        if (this.closing)
            return Result.err(poolClosedError(driver, context));
        let acquired = await this.acquire(driver, context);
        if (acquired.isErr())
            return acquired;
        let entry = acquired.value;
        let runtime = entry.runtime;
        if (!runtime)
            throw new Error("Local agent runtime was created without a runtime.");
        if (!runtime.isAlive()) {
            await this.discardRuntime(entry, driver.provider, "runtime_not_alive");
            acquired = await this.acquire(driver, context);
            if (acquired.isErr())
                return acquired;
            entry = acquired.value;
            runtime = entry.runtime;
            if (!runtime || !runtime.isAlive()) {
                await this.discardRuntime(entry, driver.provider, "runtime_not_alive");
                return Result.err(new AgentProviderUnavailableError({
                    code: "PROVIDER_UNAVAILABLE",
                    provider: driver.provider,
                    agentId: context.agentId,
                    operation: "acquire_runtime",
                    retryable: true,
                    message: "Local agent runtime exited during startup.",
                }));
            }
        }
        this.clearIdleTimer(entry);
        entry.activeRuns += 1;
        const sessionIds = new Set();
        const reserveSession = async (providerSessionId) => {
            if (!providerSessionId || sessionIds.has(providerSessionId))
                return undefined;
            while (true) {
                const existing = entry.sessions.get(providerSessionId);
                if (existing?.releasePromise) {
                    await existing.releasePromise;
                    continue;
                }
                if (entry.closing)
                    return poolClosedError(driver, context);
                const session = existing ?? { activeRuns: 0, lastUsedAt: this.now() };
                sessionIds.add(providerSessionId);
                session.activeRuns += 1;
                session.lastUsedAt = this.now();
                entry.sessions.set(providerSessionId, session);
                return undefined;
            }
        };
        const callbacks = {
            onSessionId: async (providerSessionId) => {
                const reservationError = await reserveSession(providerSessionId);
                if (reservationError)
                    throw reservationError;
                await inputCallbacks?.onSessionId?.(providerSessionId);
            },
        };
        const startedAt = this.now();
        try {
            const inputReservationError = await reserveSession(input.providerSessionId ?? "");
            if (inputReservationError)
                return Result.err(inputReservationError);
            const result = await runtime.run(input, callbacks);
            if (result.isErr()) {
                if (!runtime.isAlive()) {
                    try {
                        await this.removeAndClose(entry, "runtime_crashed");
                    }
                    catch (cleanupError) {
                        this.log("warn", "harness_runtime_close_failed", {
                            provider: driver.provider,
                            runtimeKeyHash: hashRuntimeKey(entry.key),
                            reason: "runtime_crashed",
                            error: errorMessage(cleanupError),
                        });
                    }
                    this.log("warn", "harness_runtime_crashed", {
                        provider: driver.provider,
                        runtimeKeyHash: hashRuntimeKey(entry.key),
                        agentId: context.agentId,
                        providerSessionIdPrefix: input.providerSessionId?.slice(0, 8),
                        durationMs: Math.max(0, Math.round(this.now() - startedAt)),
                        error: result.error.message,
                    });
                }
                return result;
            }
            const outputReservationError = await reserveSession(result.value.providerSessionId ?? "");
            if (outputReservationError) {
                this.log("warn", "harness_session_reservation_failed", {
                    provider: driver.provider,
                    runtimeKeyHash: hashRuntimeKey(entry.key),
                    agentId: context.agentId,
                    error: outputReservationError.message,
                });
            }
            return result;
        }
        catch (error) {
            if (!runtime.isAlive()) {
                try {
                    await this.removeAndClose(entry, "runtime_crashed");
                }
                catch (cleanupError) {
                    this.log("warn", "harness_runtime_close_failed", {
                        provider: driver.provider,
                        runtimeKeyHash: hashRuntimeKey(entry.key),
                        reason: "runtime_crashed",
                        error: errorMessage(cleanupError),
                    });
                }
                this.log("warn", "harness_runtime_crashed", {
                    provider: driver.provider,
                    runtimeKeyHash: hashRuntimeKey(entry.key),
                    agentId: context.agentId,
                    providerSessionIdPrefix: input.providerSessionId?.slice(0, 8),
                    durationMs: Math.max(0, Math.round(this.now() - startedAt)),
                    error: errorMessage(error),
                });
            }
            throw error;
        }
        finally {
            for (const providerSessionId of sessionIds) {
                const session = entry.sessions.get(providerSessionId);
                if (!session)
                    continue;
                session.activeRuns = Math.max(0, session.activeRuns - 1);
                session.lastUsedAt = this.now();
            }
            entry.activeRuns -= 1;
            if (entry.activeRuns === 0) {
                for (const resolve of entry.activeRunWaiters)
                    resolve();
                entry.activeRunWaiters.clear();
            }
            entry.lastUsedAt = this.now();
            if (entry.activeRuns === 0 && !entry.closing)
                this.scheduleIdleClose(entry);
        }
    }
    async discardRuntime(entry, provider, reason) {
        try {
            await this.removeAndClose(entry, reason);
        }
        catch (error) {
            this.log("warn", "harness_runtime_close_failed", {
                provider,
                runtimeKeyHash: hashRuntimeKey(entry.key),
                reason,
                error: errorMessage(error),
            });
        }
    }
    /** Evict entries whose runtime has been idle beyond their driver's TTL. */
    async evictIdle(now = this.now()) {
        const evictions = [];
        for (const entry of this.entries.values()) {
            if (entry.closing || !entry.runtime)
                continue;
            await this.releaseIdleSessions(entry, now);
            if (entry.activeRuns === 0 && now - entry.lastUsedAt >= entry.idleTimeoutMs) {
                evictions.push(this.removeAndClose(entry, "idle_timeout"));
            }
        }
        await Promise.all(evictions);
    }
    async close() {
        if (this.closePromise)
            return this.closePromise;
        this.closing = true;
        const entries = Array.from(this.entries.values());
        this.entries.clear();
        this.closePromise = Promise.allSettled(entries.map((entry) => this.closeEntry(entry, "server_shutdown")))
            .then(() => undefined);
        return this.closePromise;
    }
    get size() {
        return this.entries.size;
    }
    async acquire(driver, context) {
        const key = driver.runtimeKey(context);
        while (true) {
            const existing = this.entries.get(key);
            if (existing && !existing.closing) {
                if (!existing.runtime || existing.runtime.isAlive()) {
                    this.clearIdleTimer(existing);
                    if (existing.runtime) {
                        this.log("info", "harness_runtime_reused", {
                            provider: driver.provider,
                            runtimeKeyHash: hashRuntimeKey(key),
                            agentId: context.agentId,
                        });
                    }
                    const created = await existing.createPromise;
                    if (created.isErr())
                        return created;
                    if (!this.closing &&
                        !existing.closing &&
                        this.entries.get(key) === existing &&
                        existing.runtime?.isAlive()) {
                        return Result.ok(existing);
                    }
                }
                await this.removeAndClose(existing, "runtime_not_alive");
                continue;
            }
            if (this.closing)
                return Result.err(poolClosedError(driver, context));
            let entry;
            const createPromise = Promise.resolve()
                .then(() => driver.createRuntime(context))
                .then((result) => {
                if (result.isErr()) {
                    if (this.entries.get(key) === entry)
                        this.entries.delete(key);
                    return result;
                }
                const runtime = result.value;
                entry.runtime = runtime;
                entry.lastUsedAt = this.now();
                this.log("info", "harness_runtime_started", {
                    provider: driver.provider,
                    runtimeKeyHash: hashRuntimeKey(key),
                    agentId: context.agentId,
                });
                return result;
            })
                .catch((error) => {
                if (this.entries.get(key) === entry)
                    this.entries.delete(key);
                throw error;
            });
            entry = {
                key,
                driver,
                idleTimeoutMs: driver.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
                sessionIdleTimeoutMs: this.sessionIdleTimeoutMs,
                createPromise,
                activeRuns: 0,
                lastUsedAt: this.now(),
                closing: false,
                sessions: new Map(),
                activeRunWaiters: new Set(),
            };
            this.entries.set(key, entry);
            const created = await createPromise;
            if (created.isErr())
                return created;
            if (this.closing || entry.closing || this.entries.get(key) !== entry) {
                await this.closeEntry(entry, "pool_shutdown_during_creation");
                return Result.err(poolClosedError(driver, context));
            }
            return Result.ok(entry);
        }
    }
    scheduleIdleClose(entry) {
        this.clearIdleTimer(entry);
        if (!Number.isFinite(entry.idleTimeoutMs) || entry.idleTimeoutMs <= 0)
            return;
        entry.idleTimer = setTimeout(() => {
            void this.evictIdle().catch((error) => {
                this.log("warn", "harness_runtime_close_failed", {
                    provider: entry.driver.provider,
                    runtimeKeyHash: hashRuntimeKey(entry.key),
                    reason: "idle_timeout",
                    error: errorMessage(error),
                });
            });
        }, entry.idleTimeoutMs);
        entry.idleTimer.unref();
    }
    clearIdleTimer(entry) {
        if (!entry.idleTimer)
            return;
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
    }
    async removeAndClose(entry, reason) {
        if (this.entries.get(entry.key) === entry)
            this.entries.delete(entry.key);
        await this.closeEntry(entry, reason);
    }
    async closeEntry(entry, reason) {
        if (entry.closePromise)
            return entry.closePromise;
        entry.closing = true;
        this.clearIdleTimer(entry);
        entry.closePromise = (async () => {
            let runtime;
            try {
                const created = await entry.createPromise;
                if (created.isErr())
                    return;
                runtime = created.value;
            }
            catch {
                return;
            }
            if (!runtime)
                return;
            if (reason !== "server_shutdown" && reason !== "runtime_crashed" && reason !== "runtime_not_alive") {
                await this.waitForNoActiveRuns(entry);
            }
            if (reason === "server_shutdown") {
                // Shutdown is terminal for the provider runtime. Closing it first
                // aborts stuck turns and avoids waiting forever before process cleanup.
                // Do not start new individual releases here: that would race an active
                // turn, and the provider runtime owns their final cleanup. Existing
                // idle-release work is awaited so provider cleanup never overlaps it.
                await this.waitForSessionReleases(entry);
                try {
                    await runtime.close();
                    this.log("info", "harness_runtime_closed", {
                        provider: entry.driver.provider,
                        runtimeKeyHash: hashRuntimeKey(entry.key),
                        reason,
                    });
                }
                catch (error) {
                    this.log("warn", "harness_runtime_close_failed", {
                        provider: entry.driver.provider,
                        runtimeKeyHash: hashRuntimeKey(entry.key),
                        reason,
                        error: errorMessage(error),
                    });
                }
                entry.sessions.clear();
                return;
            }
            await this.releaseSessions(entry, runtime, reason);
            try {
                await runtime.close();
                this.log("info", "harness_runtime_closed", {
                    provider: entry.driver.provider,
                    runtimeKeyHash: hashRuntimeKey(entry.key),
                    reason,
                });
            }
            catch (error) {
                this.log("warn", "harness_runtime_close_failed", {
                    provider: entry.driver.provider,
                    runtimeKeyHash: hashRuntimeKey(entry.key),
                    reason,
                    error: errorMessage(error),
                });
                throw error;
            }
        })();
        return entry.closePromise;
    }
    async releaseIdleSessions(entry, now) {
        const releases = [];
        for (const [providerSessionId, session] of entry.sessions) {
            if (session.activeRuns > 0 || now - session.lastUsedAt < entry.sessionIdleTimeoutMs)
                continue;
            releases.push(this.releaseSession(entry, providerSessionId));
        }
        await Promise.all(releases);
    }
    async releaseSessions(entry, runtime, reason) {
        const releases = Array.from(entry.sessions.keys()).map((providerSessionId) => this.releaseSession(entry, providerSessionId, runtime, reason));
        await Promise.all(releases);
        entry.sessions.clear();
    }
    async releaseSession(entry, providerSessionId, runtime = entry.runtime, reason = "idle_timeout") {
        const session = entry.sessions.get(providerSessionId);
        if (!runtime || !session)
            return;
        if (entry.closing && reason === "idle_timeout")
            return;
        if (session.releasePromise)
            return session.releasePromise;
        const releasePromise = (async () => {
            try {
                await runtime.releaseSession(providerSessionId);
                if (entry.sessions.get(providerSessionId) === session && session.activeRuns === 0) {
                    entry.sessions.delete(providerSessionId);
                }
            }
            catch (error) {
                this.log("warn", "harness_session_release_failed", {
                    provider: entry.driver.provider,
                    runtimeKeyHash: hashRuntimeKey(entry.key),
                    providerSessionIdPrefix: providerSessionId.slice(0, 8),
                    reason,
                    error: errorMessage(error),
                });
            }
        })();
        session.releasePromise = releasePromise;
        try {
            await releasePromise;
        }
        finally {
            if (entry.sessions.get(providerSessionId) === session)
                session.releasePromise = undefined;
        }
    }
    async waitForNoActiveRuns(entry) {
        if (entry.activeRuns === 0)
            return;
        await new Promise((resolve) => entry.activeRunWaiters.add(resolve));
    }
    async waitForSessionReleases(entry) {
        const releases = Array.from(entry.sessions.values())
            .map((session) => session.releasePromise)
            .filter((release) => Boolean(release));
        await Promise.all(releases);
    }
    log(level, event, fields) {
        this.logger?.(level, event, fields);
    }
}
function poolClosedError(driver, context) {
    return new AgentProviderUnavailableError({
        code: "PROVIDER_UNAVAILABLE",
        provider: driver.provider,
        agentId: context.agentId,
        operation: "acquire_runtime",
        retryable: true,
        message: "Local agent runtime pool is closed.",
    });
}
function hashRuntimeKey(key) {
    return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
