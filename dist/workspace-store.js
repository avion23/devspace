import { and, eq } from "drizzle-orm";
import { openDatabase } from "./db/client.js";
import { workspaceConversationBindings, workspaceSessions, } from "./db/schema.js";
export class SqliteWorkspaceStore {
    database;
    constructor(stateDir) {
        this.database = openDatabase(stateDir);
    }
    createSession(input) {
        const now = new Date().toISOString();
        const session = {
            id: input.id,
            root: input.root,
            status: "active",
            mode: input.mode ?? "checkout",
            sourceRoot: input.sourceRoot,
            baseRef: input.baseRef,
            baseSha: input.baseSha,
            managed: input.managed ?? false,
            createdAt: now,
            lastUsedAt: now,
        };
        this.database.db
            .insert(workspaceSessions)
            .values({
            id: session.id,
            root: session.root,
            status: session.status,
            mode: session.mode,
            sourceRoot: session.sourceRoot ?? null,
            baseRef: session.baseRef ?? null,
            baseSha: session.baseSha ?? null,
            managed: String(session.managed),
            createdAt: session.createdAt,
            lastUsedAt: session.lastUsedAt,
        })
            .run();
        return session;
    }
    getSession(id) {
        const row = this.database.db
            .select()
            .from(workspaceSessions)
            .where(eq(workspaceSessions.id, id))
            .get();
        return row ? rowToWorkspaceSession(row) : undefined;
    }
    touchSession(id) {
        this.database.db
            .update(workspaceSessions)
            .set({ lastUsedAt: new Date().toISOString() })
            .where(eq(workspaceSessions.id, id))
            .run();
    }
    getConversationBinding(conversationScopeId, targetKey) {
        const row = this.database.db
            .select()
            .from(workspaceConversationBindings)
            .where(and(eq(workspaceConversationBindings.conversationScopeId, conversationScopeId), eq(workspaceConversationBindings.targetKey, targetKey)))
            .get();
        return row ? rowToWorkspaceConversationBinding(row) : undefined;
    }
    setConversationBinding(input) {
        const now = new Date().toISOString();
        const row = this.database.db
            .insert(workspaceConversationBindings)
            .values({
            conversationScopeId: input.conversationScopeId,
            targetKey: input.targetKey,
            workspaceSessionId: input.workspaceSessionId,
            createdAt: now,
            lastUsedAt: now,
        })
            .onConflictDoUpdate({
            target: [
                workspaceConversationBindings.conversationScopeId,
                workspaceConversationBindings.targetKey,
            ],
            set: {
                workspaceSessionId: input.workspaceSessionId,
                lastUsedAt: now,
            },
        })
            .returning()
            .get();
        if (!row) {
            throw new Error("Conversation workspace binding upsert returned no row.");
        }
        return rowToWorkspaceConversationBinding(row);
    }
    touchConversationBinding(conversationScopeId, targetKey) {
        this.database.db
            .update(workspaceConversationBindings)
            .set({ lastUsedAt: new Date().toISOString() })
            .where(and(eq(workspaceConversationBindings.conversationScopeId, conversationScopeId), eq(workspaceConversationBindings.targetKey, targetKey)))
            .run();
    }
    deleteConversationBinding(conversationScopeId, targetKey) {
        this.database.db
            .delete(workspaceConversationBindings)
            .where(and(eq(workspaceConversationBindings.conversationScopeId, conversationScopeId), eq(workspaceConversationBindings.targetKey, targetKey)))
            .run();
    }
    close() {
        this.database.close();
    }
}
export function createWorkspaceStore(stateDir) {
    return new SqliteWorkspaceStore(stateDir);
}
function rowToWorkspaceSession(row) {
    return {
        id: row.id,
        root: row.root,
        status: row.status,
        mode: row.mode === "worktree" ? "worktree" : "checkout",
        sourceRoot: row.sourceRoot ?? undefined,
        baseRef: row.baseRef ?? undefined,
        baseSha: row.baseSha ?? undefined,
        managed: row.managed === "true",
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
    };
}
function rowToWorkspaceConversationBinding(row) {
    return {
        conversationScopeId: row.conversationScopeId,
        targetKey: row.targetKey,
        workspaceSessionId: row.workspaceSessionId,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
    };
}
