import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result } from "better-result";
import { openDatabase } from "./db/client.js";
import { AgentStoreError, isProgrammerDefect } from "./local-agent-errors.js";
export class LocalAgentStore {
    database;
    constructor(stateDir) {
        this.database = openDatabase(stateDir);
    }
    list(scope = {}) {
        let rows;
        if (scope.workspaceId && scope.workspaceRoot) {
            rows = this.database.sqlite
                .prepare(`select * from local_agent_sessions
           where workspace_id = ? and workspace_root = ?
           order by updated_at desc`)
                .all(scope.workspaceId, resolve(scope.workspaceRoot));
        }
        else if (scope.workspaceId) {
            rows = this.database.sqlite
                .prepare(`select * from local_agent_sessions
           where workspace_id = ?
           order by updated_at desc`)
                .all(scope.workspaceId);
        }
        else if (scope.workspaceRoot) {
            rows = this.database.sqlite
                .prepare(`select * from local_agent_sessions
           where workspace_root = ?
           order by updated_at desc`)
                .all(resolve(scope.workspaceRoot));
        }
        else {
            rows = this.database.sqlite
                .prepare("select * from local_agent_sessions order by updated_at desc")
                .all();
        }
        return rows.map(rowToLocalAgentRecord);
    }
    listResult(scope = {}) {
        return storeResult("list", () => this.list(scope));
    }
    create(input) {
        const now = new Date().toISOString();
        const record = {
            id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
            workspaceId: input.workspaceId,
            workspaceRoot: resolve(input.workspaceRoot),
            profileName: input.profileName,
            provider: input.provider,
            model: input.model,
            effort: input.effort,
            status: "starting",
            createdAt: now,
            updatedAt: now,
        };
        this.database.sqlite
            .prepare(`insert into local_agent_sessions (
          id,
          workspace_id,
          workspace_root,
          profile_name,
          provider,
          model,
          effort,
          status,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(record.id, record.workspaceId ?? null, record.workspaceRoot, record.profileName, record.provider, record.model ?? null, record.effort ?? null, record.status, record.createdAt, record.updatedAt);
        return record;
    }
    createResult(input) {
        return storeResult("create", () => this.create(input));
    }
    getById(id) {
        const exact = this.database.sqlite
            .prepare(`select * from local_agent_sessions
         where id = ?
         limit 1`)
            .get(id);
        return exact ? rowToLocalAgentRecord(exact) : undefined;
    }
    getByIdResult(id) {
        return storeResult("get", () => this.getById(id));
    }
    /**
     * Compatibility alias for callers that already use the store directly.
     * Identity lookup is exact and never falls back to provider session IDs.
     */
    get(id) {
        return this.getById(id);
    }
    update(id, patch) {
        const current = this.getById(id);
        if (!current)
            throw new Error(`Unknown subagent id: ${id}`);
        const updated = {
            ...current,
            ...patch,
            updatedAt: new Date().toISOString(),
        };
        this.database.sqlite
            .prepare(`update local_agent_sessions set
          workspace_id = ?,
          workspace_root = ?,
          profile_name = ?,
          provider = ?,
          model = ?,
          effort = ?,
          provider_session_id = ?,
          status = ?,
          latest_response = ?,
          error = ?,
          error_code = ?,
          error_retryable = ?,
          updated_at = ?
         where id = ?`)
            .run(updated.workspaceId ?? null, resolve(updated.workspaceRoot), updated.profileName, updated.provider, updated.model ?? null, updated.effort ?? null, updated.providerSessionId ?? null, updated.status, updated.latestResponse ?? null, updated.error ?? null, updated.errorCode ?? null, updated.errorRetryable === undefined ? null : String(updated.errorRetryable), updated.updatedAt, updated.id);
        return updated;
    }
    updateResult(id, patch) {
        return storeResult("update", () => this.update(id, patch));
    }
    reconcileActiveRuns(message = "DevSpace restarted while this agent turn was running.") {
        const now = new Date().toISOString();
        const result = this.database.sqlite
            .prepare(`update local_agent_sessions
         set status = 'error', error = ?, error_code = 'DAEMON_UNAVAILABLE', error_retryable = 'true', updated_at = ?
         where status in ('starting', 'running')`)
            .run(message, now);
        return Number(result.changes);
    }
    reconcileActiveRunsResult(message = "DevSpace restarted while this agent turn was running.") {
        return storeResult("reconcile_active_runs", () => this.reconcileActiveRuns(message));
    }
    close() {
        this.database.close();
    }
}
export function createLocalAgentStore(stateDir) {
    return new LocalAgentStore(stateDir);
}
function rowToLocalAgentRecord(row) {
    return {
        id: row.id,
        workspaceId: row.workspace_id ?? undefined,
        workspaceRoot: row.workspace_root,
        profileName: row.profile_name,
        provider: row.provider,
        model: row.model ?? undefined,
        effort: row.effort ?? undefined,
        providerSessionId: row.provider_session_id ?? undefined,
        status: readStatus(row.status),
        latestResponse: row.latest_response ?? undefined,
        error: row.error ?? undefined,
        errorCode: row.error_code ?? undefined,
        errorRetryable: readOptionalBoolean(row.error_retryable),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function readOptionalBoolean(value) {
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return undefined;
}
function storeResult(operation, run) {
    try {
        return Result.ok(run());
    }
    catch (cause) {
        if (isProgrammerDefect(cause))
            throw cause;
        return Result.err(new AgentStoreError(operation, cause));
    }
}
function readStatus(status) {
    if (status === "starting" ||
        status === "running" ||
        status === "idle" ||
        status === "error" ||
        status === "stopped") {
        return status;
    }
    return "error";
}
