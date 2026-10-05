import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createOAuthMetadata, mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE, } from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import * as z from "zod/v4";
import { applyPatch } from "./apply-patch.js";
import { isArtifactDownloadSupportedPlatform, registerArtifactTools, } from "./artifact-tools.js";
import { loadConfig } from "./config.js";
import { createOpenAIIncomingArtifactAdapter, } from "./incoming-artifacts.js";
import { logEvent, requestIp, requestPath, commandPreview, } from "./logger.js";
import { BASH_TOOL_DEFAULT_TIMEOUT_SECONDS, BASH_TOOL_MAX_TIMEOUT_SECONDS, editFileTool, findFilesTool, grepFilesTool, listDirectoryTool, readFileTool, writeFileTool, } from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { getLocalAgentProviderAvailabilitySnapshot, } from "./local-agent-availability.js";
import { buildLocalAgentCatalog, buildLocalAgentProviderStatuses, } from "./local-agent-catalog.js";
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
};
function shouldAttachWidget(mode, kind) {
    switch (mode) {
        case "off":
            return false;
        case "changes":
            return kind === "workspace" || kind === "show_changes";
        case "full":
            return true;
    }
}
function toolWidgetDescriptorMeta(config, kind) {
    if (!shouldAttachWidget(config.widgets, kind))
        return { _meta: {} };
    return {
        _meta: {
            ui: {
                resourceUri: WORKSPACE_APP_URI,
                visibility: ["model"],
            },
        },
    };
}
const toolNames = {
    openWorkspace: "open_workspace",
    read: "read",
    write: "write",
    edit: "edit",
    grep: "grep",
    glob: "glob",
    ls: "ls",
    shell: "bash",
};
const workspaceIdDescription = "Workspace to use. Reuse the current project's workspaceId.";
function executionInstructions(config) {
    const writes = config.toolMode === "codex"
        ? "Use apply_patch for project file modifications."
        : "Use edit for targeted modifications, write for new files or complete rewrites.";
    return `${writes} Use ${config.toolMode === "codex" ? "exec_command" : "bash or exec_command"} to execute inspection, tests, builds, and other shell work. ${config.toolMode === "codex" ? "exec_command" : "Bash and exec_command"} calls yield within 10 seconds by default (exec_command can wait up to 30 seconds via yieldTimeMs); write_stdin yields within 5 seconds when polling, or 250 ms when sending input, also configurable up to 30 seconds. This does not kill valid long work. If running=true, keep the sessionId and use write_stdin with the same workspaceId to retrieve subsequent output and the final exit status; do not rerun the command. To cancel, send chars="\\u0003" with write_stdin.${config.toolMode === "codex" ? "" : " Bash timeout is the actual execution deadline across all polls, not an HTTP wait time."}`;
}
function serverInstructions(config) {
    const artifactInstruction = config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
        ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
        : "";
    const showChangesInstruction = config.widgets === "changes"
        ? " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
        : "";
    if (config.toolMode === "codex") {
        return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. ${executionInstructions(config)} Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${artifactInstruction}${showChangesInstruction}`;
    }
    const inspection = config.toolMode !== "full"
        ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
        : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;
    const skills = config.skillsEnabled
        ? `When ${toolNames.openWorkspace} returns available skills and a task matches a skill, use ${toolNames.read} to read that skill's path before proceeding. Skill paths may be outside the workspace, but ${toolNames.read} only permits advertised SKILL.md files and files under already-loaded skill directories. `
        : "";
    const agentsMd = `Follow instructions returned by ${toolNames.openWorkspace}. Before working under a path listed in availableAgentsFiles, use ${toolNames.read} to inspect that instruction file and follow it. `;
    return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. ${agentsMd}${skills}${inspection}${executionInstructions(config)} Prefer ${toolNames.edit} for targeted modifications and ${toolNames.write} only for new files or complete rewrites; use ${toolNames.shell} for tests, builds, git inspection, git state changes (add, commit, merge, rebase, push), package scripts, and commands that are better executed by the shell. Do not create or modify project file content with ${toolNames.shell}; avoid shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or any command whose purpose is to write project files. Generated build artifacts (target/, caches, coverage, reports) written by test and build commands are expected.${artifactInstruction}${showChangesInstruction}`;
}
function formatVisibleAgent(agent) {
    const model = agent.model ? `, model ${agent.model}` : "";
    const effort = agent.effort ? `, effort ${agent.effort}` : "";
    return `${agent.name} (${agent.provider}${model}${effort})`;
}
function formatAvailableAgentProvider(provider) {
    const details = [
        provider.model ? `model ${provider.model}` : undefined,
        provider.effort ? `effort ${provider.effort}` : undefined,
        provider.note,
    ].filter(Boolean).join(", ");
    return `${provider.id}${details ? ` (${details})` : ""}`;
}
function resultOutputSchema(extra = {}) {
    return {
        result: z
            .string()
            .describe("Model-readable result text for follow-up reasoning and plain MCP hosts."),
        ...extra,
    };
}
const workspaceSkillOutputSchema = z.object({
    name: z.string(),
    description: z.string(),
    path: z.string(),
});
const workspaceAgentsFileOutputSchema = z.object({
    path: z.string(),
    content: z.string(),
});
const workspaceLocalAgentOutputSchema = z.object({
    name: z.string(),
    description: z.string(),
    provider: z.string(),
    model: z.string().optional(),
    effort: z.string().optional(),
});
const workspaceLocalAgentProviderOutputSchema = z.object({
    id: z.string(),
    model: z.string().optional(),
    effort: z.string().optional(),
    note: z.string().optional(),
});
const workspaceAvailableAgentsFileOutputSchema = z.object({
    path: z.string(),
});
const reviewFileOutputSchema = z.object({
    path: z.string(),
    previousPath: z.string().optional(),
    type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
    additions: z.number(),
    removals: z.number(),
});
const reviewSummaryOutputSchema = z.object({
    files: z.number(),
    additions: z.number(),
    removals: z.number(),
});
function sendJsonRpcError(res, status, code, message) {
    res.status(status).json({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
    });
}
function requestLogFields(req, config) {
    return {
        ip: requestIp(req, config.logging.trustProxy),
        host: req.header("host"),
        userAgent: req.header("user-agent"),
        origin: req.header("origin"),
        referer: req.header("referer"),
        contentLength: req.header("content-length"),
    };
}
function logToolCall(config, fields) {
    if (!config.logging.toolCalls)
        return;
    const { command, ...safeFields } = fields;
    logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
        ...safeFields,
        commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
    });
}
function contentText(content) {
    return content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
}
function toolErrorPreview(content) {
    const text = contentText(content).replace(/\s+/g, " ").trim();
    if (!text)
        return undefined;
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
function logFailedToolResponse(config, fields, content, startedAt) {
    logToolCall(config, {
        ...fields,
        success: false,
        durationMs: Math.round(performance.now() - startedAt),
        error: toolErrorPreview(content),
    });
}
function textBlock(text) {
    return { type: "text", text };
}
function textSummary(content) {
    const text = contentText(content);
    return {
        lines: text.length === 0 ? 0 : text.split("\n").length,
        characters: text.length,
    };
}
function contentLineCount(content) {
    if (content.length === 0)
        return 0;
    return content.endsWith("\n")
        ? content.slice(0, -1).split("\n").length
        : content.split("\n").length;
}
function countDiffStats(diff) {
    if (!diff)
        return { additions: 0, removals: 0 };
    let additions = 0;
    let removals = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++"))
            additions++;
        if (line.startsWith("-") && !line.startsWith("---"))
            removals++;
    }
    return { additions, removals };
}
function newFilePatch(path, content) {
    const lines = content.length === 0
        ? []
        : content.endsWith("\n")
            ? content.slice(0, -1).split("\n")
            : content.split("\n");
    const hunkLength = lines.length;
    const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
    const body = lines.map((line) => `+${line}`).join("\n");
    return [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "index 0000000..0000000",
        "--- /dev/null",
        `+++ b/${path}`,
        `@@ -0,0 ${hunkRange} @@`,
        body,
    ]
        .filter((line) => line.length > 0)
        .join("\n");
}
function assetBaseUrl(config) {
    return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}
function uiManifestUrl() {
    return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}
function readWorkspaceAppManifest() {
    return JSON.parse(readFileSync(uiManifestUrl(), "utf8"));
}
function getWorkspaceAppManifestEntry() {
    const manifest = readWorkspaceAppManifest();
    const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];
    if (!entry?.file) {
        throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
    }
    return entry;
}
function assetUrl(baseUrl, assetPath) {
    return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}
function workspaceAppHtml(config) {
    const baseUrl = assetBaseUrl(config);
    const entry = getWorkspaceAppManifestEntry();
    const stylesheets = (entry.css ?? [])
        .map((stylesheet) => `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`)
        .join("\n");
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}
function appCsp(config) {
    const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
    return {
        resourceDomains: [publicBaseUrl],
        connectDomains: [publicBaseUrl],
    };
}
function uiBuildDirectory() {
    return fileURLToPath(new URL("../dist/ui", import.meta.url));
}
function setAssetHeaders(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}
async function assertWorkspaceAppAssets() {
    const entry = getWorkspaceAppManifestEntry();
    const candidates = [entry.file, ...(entry.css ?? [])].map((assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url));
    for (const candidate of candidates) {
        await access(candidate);
    }
}
function processResult(snapshot) {
    const status = snapshot.running
        ? `Process running with session ID ${snapshot.sessionId}. Poll with write_stdin using this workspaceId and sessionId; do not rerun the command. Send chars="\\u0003" to cancel.`
        : snapshot.timedOut
            ? `Command timed out after ${snapshot.timeoutSeconds} seconds; owned process group cleanup completed. Intentionally detached groups are outside cancellation scope.`
            : snapshot.signal
                ? `Process exited after signal ${snapshot.signal}.`
                : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
    return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}
function processOutputSchema() {
    return resultOutputSchema({
        sessionId: z.number().optional(),
        running: z.boolean(),
        exitCode: z.number().int().optional(),
        signal: z.string().optional(),
        timedOut: z.boolean(),
        timeoutSeconds: z.number().positive().optional(),
        wallTimeMs: z.number().nonnegative(),
        outputTruncated: z.boolean(),
    });
}
function processToolResponse(tool, workspaceId, snapshot, summary) {
    const result = processResult(snapshot);
    const content = [textBlock(result)];
    const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
    return {
        content,
        isError: !snapshot.running && (snapshot.timedOut || Boolean(snapshot.signal) || snapshot.exitCode !== 0),
        _meta: {
            tool,
            card: {
                workspaceId,
                summary: { ...summary, ...outputSummary },
                payload: { content },
            },
        },
        structuredContent: {
            result,
            sessionId: snapshot.sessionId,
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            signal: snapshot.signal,
            timedOut: snapshot.timedOut,
            timeoutSeconds: snapshot.timeoutSeconds,
            wallTimeMs: snapshot.wallTimeMs,
            outputTruncated: snapshot.outputTruncated,
        },
    };
}
function registerProcessTools(server, config, workspaces, processSessions) {
    registerAppTool(server, "exec_command", {
        title: "Execute command",
        description: `Run a command in a workspace. Returns within 10 seconds by default (configurable up to 30 seconds via yieldTimeMs) with the exit result or a running sessionId for write_stdin. Use for inspection, tests, builds, package scripts, and long-running processes. ${config.toolMode === "codex" ? "Use apply_patch for project file modifications." : "Use edit/write for project file modifications, not shell commands."}`,
        inputSchema: {
            workspaceId: z.string().describe(workspaceIdDescription),
            cmd: z.string().min(1).describe("Shell command to execute."),
            tty: z
                .boolean()
                .optional()
                .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
            columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
            rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
            workingDirectory: z
                .string()
                .optional()
                .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
            yieldTimeMs: z
                .number()
                .int()
                .min(0)
                .max(30_000)
                .optional()
                .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
            maxOutputTokens: z
                .number()
                .int()
                .positive()
                .max(100_000)
                .optional()
                .describe("Approximate output token budget. Defaults to 3000."),
        },
        outputSchema: processOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: SHELL_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
        const snapshot = await processSessions.start({
            workspaceId,
            command: cmd,
            cwd,
            workspaceRoot: workspace.root,
            tty,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
        });
        logToolCall(config, {
            tool: "exec_command",
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: cmd,
            commandLength: cmd.length,
            success: snapshot.running || (!snapshot.timedOut && !snapshot.signal && snapshot.exitCode === 0),
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            timedOut: snapshot.timedOut,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return processToolResponse("exec_command", workspaceId, snapshot, {
            command: cmd,
            workingDirectory: workingDirectory ?? ".",
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
        });
    });
    registerAppTool(server, "write_stdin", {
        title: "Write to process",
        description: "Poll or write characters to a process returned by bash or exec_command. Polls return within 5 seconds and writes/resizes within 250 ms by default (configurable up to 30 seconds via yieldTimeMs); keep polling while running is true to retrieve final output and exit status. Omit chars or pass an empty string to poll. Pass \\u0003 to cancel the owned process group with Ctrl-C (forced termination after a short grace period). Intentionally detached groups are outside cancellation scope.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace identifier used to start the process."),
            sessionId: z.number().int().positive().describe("Process session identifier returned by bash or exec_command."),
            chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
            columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
            rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
            yieldTimeMs: z
                .number()
                .int()
                .min(0)
                .max(30_000)
                .optional()
                .describe("Milliseconds to wait for completion (at most 30000). Polls default to 5000, writes/resizes to 250; buffered output returns immediately."),
            maxOutputTokens: z
                .number()
                .int()
                .positive()
                .max(100_000)
                .optional()
                .describe("Approximate output token budget. Defaults to 3000."),
        },
        outputSchema: processOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "shell"),
        annotations: SHELL_TOOL_ANNOTATIONS,
    }, async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
        const startedAt = performance.now();
        workspaces.getWorkspace(workspaceId);
        const snapshot = await processSessions.write({
            workspaceId,
            sessionId,
            chars,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
        });
        logToolCall(config, {
            tool: "write_stdin",
            workspaceId,
            success: snapshot.running || (!snapshot.timedOut && !snapshot.signal && snapshot.exitCode === 0),
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            timedOut: snapshot.timedOut,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return processToolResponse("write_stdin", workspaceId, snapshot, {
            sessionId,
            charactersWritten: chars?.length ?? 0,
            running: snapshot.running,
            exitCode: snapshot.exitCode,
            wallTimeMs: snapshot.wallTimeMs,
        });
    });
}
export function createMcpServer(config, workspaces, reviewCheckpoints, processSessions, resolveLocalAgentProviders, incomingArtifactAdapters) {
    const server = new McpServer({
        name: "devspace",
        title: "DevSpace",
        version: "0.1.0",
        description: "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspaceId.",
    }, {
        instructions: serverInstructions(config),
    });
    registerAppResource(server, "DevSpace Diff Card", WORKSPACE_APP_URI, {
        description: "Interactive card for viewing DevSpace file diffs.",
        _meta: {
            ui: {
                csp: appCsp(config),
            },
        },
    }, async () => {
        await assertWorkspaceAppAssets();
        return {
            contents: [
                {
                    uri: WORKSPACE_APP_URI,
                    mimeType: RESOURCE_MIME_TYPE,
                    text: workspaceAppHtml(config),
                    _meta: {
                        ui: {
                            csp: appCsp(config),
                        },
                    },
                },
            ],
        };
    });
    registerAppTool(server, "open_workspace", {
        title: "Open workspace",
        description: "Start work in a project directory or isolated worktree when no usable workspaceId exists for it. During continued work, reuse the existing workspaceId instead of calling this tool again. By default this uses the actual checkout; set mode=\"worktree\" for isolated or parallel work.",
        inputSchema: {
            path: z
                .string()
                .describe("Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root."),
            mode: z
                .enum(["checkout", "worktree"])
                .optional()
                .describe("Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work."),
            baseRef: z
                .string()
                .optional()
                .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
        },
        outputSchema: {
            workspaceId: z.string(),
            root: z.string(),
            mode: z.enum(["checkout", "worktree"]),
            sourceRoot: z.string().optional(),
            worktree: z
                .object({
                path: z.string(),
                baseRef: z.string(),
                baseSha: z.string(),
                dirtySource: z.boolean(),
                detached: z.boolean(),
                managed: z.boolean(),
            })
                .optional(),
            agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
            availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
            skills: z.array(workspaceSkillOutputSchema).optional(),
            agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
            agents: z.array(workspaceLocalAgentOutputSchema).optional(),
            skillDiagnostics: z.array(z.unknown()).optional(),
        },
        ...toolWidgetDescriptorMeta(config, "workspace"),
        annotations: { readOnlyHint: true },
    }, async ({ path, mode, baseRef }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace, agentsFiles, availableAgentsFiles, workspaceReused, includeBootstrapContext, } = await workspaces.openWorkspace({ path, mode, baseRef }, { conversationScopeId: openAiConversationScopeId(_meta) });
        if (config.widgets === "changes") {
            await reviewCheckpoints.initializeWorkspace({
                workspaceId: workspace.id,
                root: workspace.root,
            });
        }
        const cardSkills = workspace.skills
            .filter((skill) => !skill.disableModelInvocation)
            .map((skill) => ({
            name: skill.name,
            description: skill.description,
            path: formatPathForPrompt(skill.filePath),
        }));
        const agentCatalog = buildLocalAgentCatalog(config.subagents, workspace.agentProfiles, resolveLocalAgentProviders());
        const cardAgentProviders = agentCatalog.providers
            .filter((provider) => provider.usable)
            .map((provider) => ({
            id: provider.id,
            model: provider.model,
            effort: provider.effort,
            note: provider.note,
        }));
        const cardAgents = agentCatalog.profiles;
        const cardAgentsFiles = agentsFiles.map((file) => ({
            path: formatAgentsPath(file.path, workspace.root),
            content: file.content,
        }));
        const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
            path: formatAgentsPath(file.path, workspace.root),
        }));
        const visibleSkills = includeBootstrapContext ? cardSkills : [];
        const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
        const visibleAgents = includeBootstrapContext ? cardAgents : [];
        const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
        const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
        const cardInstruction = (config.skillsEnabled
            ? "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
            : "Use this workspaceId for subsequent work in this project. Keep reusing it while working in this project. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.") + ` ${executionInstructions(config)}`;
        const instruction = (workspaceReused
            ? [
                `Workspace already open as ${workspace.id}.`,
                "Continue with this workspaceId.",
                "Keep following the project instructions, nested instruction files, skills, agent profiles, and diagnostics already provided for this workspace.",
            ].join("\n\n")
            : workspace.mode === "worktree"
                ? "Use this workspaceId for subsequent work in this isolated worktree. Keep reusing it while working in this worktree. Follow the project instructions, nested instruction files, skills, agent profiles, and diagnostics returned for it."
                : cardInstruction) + (workspaceReused || workspace.mode === "worktree" ? ` ${executionInstructions(config)}` : "");
        const resultContent = [
            {
                type: "text",
                text: [
                    workspaceReused
                        ? `Workspace already open as ${workspace.id}.`
                        : workspace.mode === "worktree"
                            ? `Opened isolated worktree workspace ${workspace.id}.`
                            : `Opened workspace ${workspace.id}.`,
                    `Root: ${workspace.root}`,
                    `Mode: ${workspace.mode}`,
                    loadedAgentsFiles.length > 0
                        ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
                        : undefined,
                    availableAgentsFileOutputs.length > 0
                        ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
                        : undefined,
                    visibleSkills.length > 0
                        ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
                        : undefined,
                    visibleAgentProviders.length > 0
                        ? `Available subagent providers: ${visibleAgentProviders.map(formatAvailableAgentProvider).join(", ")}`
                        : undefined,
                    visibleAgents.length > 0
                        ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
                        : undefined,
                    instruction,
                ].filter(Boolean).join("\n"),
            },
        ];
        logToolCall(config, {
            tool: "open_workspace",
            workspaceId: workspace.id,
            path: workspace.root,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            content: resultContent,
            _meta: {
                tool: "open_workspace",
                card: {
                    workspaceId: workspace.id,
                    root: workspace.root,
                    path: workspace.root,
                    mode: workspace.mode,
                    workspaceReused,
                    includeBootstrapContext,
                    sourceRoot: workspace.sourceRoot,
                    worktree: workspace.worktree,
                    agentsFiles: cardAgentsFiles,
                    availableAgentsFiles: cardAvailableAgentsFiles,
                    skills: cardSkills,
                    agentProviders: cardAgentProviders,
                    agents: cardAgents,
                    instruction: cardInstruction,
                    summary: {
                        mode: workspace.mode,
                        agentsFiles: cardAgentsFiles.length,
                        availableAgentsFiles: cardAvailableAgentsFiles.length,
                        skills: cardSkills.length,
                        agentProviders: cardAgentProviders.length,
                        agents: cardAgents.length,
                    },
                },
            },
            structuredContent: {
                workspaceId: workspace.id,
                root: workspace.root,
                mode: workspace.mode,
                sourceRoot: workspace.sourceRoot,
                worktree: workspace.worktree,
                ...(includeBootstrapContext
                    ? {
                        agentsFiles: loadedAgentsFiles,
                        availableAgentsFiles: availableAgentsFileOutputs,
                        skills: visibleSkills,
                        agentProviders: visibleAgentProviders,
                        agents: visibleAgents,
                        skillDiagnostics: workspace.skillDiagnostics,
                    }
                    : {}),
            },
        };
    });
    registerAppTool(server, toolNames.read, {
        title: "Read file",
        description: [
            "Read a file in a workspace, or the exact ~/.claude/CLAUDE.md file (read-only, no symlink redirection). Use this for file inspection instead of shell commands like cat or sed.",
            "Use this tool to inspect relevant AGENTS.md or CLAUDE.md files listed by open_workspace before working in nested directories.",
            config.skillsEnabled
                ? "If available skills were returned and a task matches one, read that skill's path before proceeding. Skill paths may be outside the workspace; only advertised SKILL.md files and files under already-loaded skill directories are readable."
                : "",
        ]
            .filter(Boolean)
            .join(" "),
        inputSchema: {
            workspaceId: z
                .string()
                .describe(workspaceIdDescription),
            path: z
                .string()
                .describe(config.skillsEnabled
                ? "Workspace-relative, absolute, or ~/ file path. Outside the workspace, only ~/.claude/CLAUDE.md, advertised SKILL.md files, and files under already-loaded skill directories are readable."
                : "Workspace-relative, absolute, or ~/ file path. Outside the workspace, only the exact ~/.claude/CLAUDE.md file is readable."),
            offset: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("1-indexed line number to start reading from."),
            limit: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Maximum number of lines to read."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "read"),
        annotations: { readOnlyHint: true },
    }, async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const readPath = workspaces.resolveReadPath(workspace, input.path);
        const response = await readFileTool({ ...input, path: readPath.absolutePath }, {
            cwd: workspace.root,
            root: workspace.root,
            readRoots: readPath.readRoots,
        });
        if (response.isError) {
            logFailedToolResponse(config, {
                tool: toolNames.read,
                workspaceId,
                path: input.path,
            }, response.content, startedAt);
            return response;
        }
        workspaces.markReadPathLoaded(workspace, readPath);
        const summary = {
            ...textSummary(response.content),
            offset: input.offset ?? 1,
            limited: input.limit !== undefined,
        };
        logToolCall(config, {
            tool: toolNames.read,
            workspaceId,
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return {
            ...response,
            _meta: {
                tool: toolNames.read,
                card: {
                    workspaceId,
                    path: input.path,
                    summary,
                    payload: { content: response.content },
                },
            },
            structuredContent: {
                result: contentText(response.content),
            },
        };
    });
    if (config.toolMode !== "codex") {
        registerAppTool(server, toolNames.write, {
            title: "Write file",
            description: `Create or completely overwrite a file in a workspace. Prefer ${toolNames.edit} for targeted changes to existing files.`,
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe(workspaceIdDescription),
                path: z
                    .string()
                    .describe("File path to write, relative to the workspace root."),
                content: z.string().describe("Complete new file content."),
            },
            outputSchema: resultOutputSchema({
                additions: z.number(),
                removals: z.number(),
                lines: z.number(),
                characters: z.number(),
            }),
            ...toolWidgetDescriptorMeta(config, "write"),
            annotations: WRITE_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            workspaces.resolvePath(workspace, input.path);
            const response = await writeFileTool(input, {
                cwd: workspace.root,
                root: workspace.root,
            });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.write,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const patch = newFilePatch(input.path, input.content);
            const stats = countDiffStats(patch);
            const summary = {
                ...stats,
                lines: contentLineCount(input.content),
                characters: input.content.length,
            };
            logToolCall(config, {
                tool: toolNames.write,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.write,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: {
                            content: response.content,
                            patch,
                        },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                    ...summary,
                },
            };
        });
        registerAppTool(server, toolNames.edit, {
            title: "Edit file",
            description: `Edit one file in a workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique.`,
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe(workspaceIdDescription),
                path: z
                    .string()
                    .describe("File path to edit, relative to the workspace root."),
                edits: z
                    .array(z.object({
                    oldText: z
                        .string()
                        .describe("Exact text to replace. Must match uniquely in the original file."),
                    newText: z.string().describe("Replacement text."),
                }))
                    .min(1),
            },
            outputSchema: resultOutputSchema({
                status: z.literal("applied"),
                additions: z.number(),
                removals: z.number(),
                editCount: z.number(),
            }),
            ...toolWidgetDescriptorMeta(config, "edit"),
            annotations: EDIT_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            workspaces.resolvePath(workspace, input.path);
            const response = await editFileTool(input, {
                cwd: workspace.root,
                root: workspace.root,
            });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.edit,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const stats = countDiffStats(response.details?.patch ?? response.details?.diff);
            const summary = {
                ...stats,
                editCount: input.edits.length,
            };
            const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
            const editContent = [textBlock(editResultText)];
            logToolCall(config, {
                tool: toolNames.edit,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                content: editContent,
                _meta: {
                    tool: toolNames.edit,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: {
                            diff: response.details?.diff,
                            patch: response.details?.patch,
                        },
                    },
                },
                structuredContent: {
                    status: "applied",
                    result: contentText(editContent),
                    additions: stats.additions,
                    removals: stats.removals,
                    editCount: input.edits.length,
                },
            };
        });
    }
    if (config.toolMode === "codex") {
        registerAppTool(server, "apply_patch", {
            title: "Apply patch",
            description: "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe(workspaceIdDescription),
                patch: z
                    .string()
                    .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
            },
            outputSchema: resultOutputSchema({
                additions: z.number(),
                removals: z.number(),
                files: z.array(z.object({
                    path: z.string(),
                    previousPath: z.string().optional(),
                    operation: z.enum(["add", "update", "delete", "move"]),
                })),
            }),
            ...toolWidgetDescriptorMeta(config, "edit"),
            annotations: EDIT_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, patch }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            const applied = await applyPatch(workspace.root, patch);
            const paths = applied.files.map((file) => file.path).join(", ");
            const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
            const content = [textBlock(result)];
            const displayPath = applied.files.length === 1
                ? applied.files[0]?.path
                : `${applied.files.length} files`;
            logToolCall(config, {
                tool: "apply_patch",
                workspaceId,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                content,
                _meta: {
                    tool: "apply_patch",
                    card: {
                        workspaceId,
                        path: displayPath,
                        summary: {
                            files: applied.files.length,
                            additions: applied.additions,
                            removals: applied.removals,
                        },
                        files: applied.files,
                        payload: { patch: applied.patch },
                    },
                },
                structuredContent: {
                    result,
                    additions: applied.additions,
                    removals: applied.removals,
                    files: applied.files,
                },
            };
        });
    }
    if (config.widgets === "changes") {
        registerAppTool(server, "show_changes", {
            title: "Show changes",
            description: "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe(workspaceIdDescription),
            },
            outputSchema: resultOutputSchema({
                summary: reviewSummaryOutputSchema,
                files: z.array(reviewFileOutputSchema),
            }),
            ...toolWidgetDescriptorMeta(config, "show_changes"),
            annotations: { readOnlyHint: true },
        }, async ({ workspaceId }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            const review = await reviewCheckpoints.reviewChanges({
                workspaceId,
                root: workspace.root,
                markReviewed: true,
            });
            const content = [textBlock(review.result)];
            logToolCall(config, {
                tool: "show_changes",
                workspaceId,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                content,
                _meta: {
                    tool: "show_changes",
                    card: {
                        workspaceId,
                        summary: review.summary,
                        files: review.files,
                        payload: {
                            patch: review.patch,
                        },
                    },
                },
                structuredContent: {
                    result: contentText(content),
                    summary: review.summary,
                    files: review.files,
                },
            };
        });
    }
    if (config.toolMode === "full") {
        registerAppTool(server, toolNames.grep, {
            title: "Grep",
            description: "Search file contents in a workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe(workspaceIdDescription),
                pattern: z.string().describe("Search pattern."),
                path: z
                    .string()
                    .optional()
                    .describe("Optional path or glob scope relative to the workspace root."),
                include: z.string().optional().describe("Optional include glob."),
            },
            outputSchema: resultOutputSchema({
                pattern: z.string(),
                scope: z.string(),
                lines: z.number(),
                characters: z.number(),
            }),
            ...toolWidgetDescriptorMeta(config, "search"),
            annotations: { readOnlyHint: true },
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            if (input.path)
                workspaces.resolvePath(workspace, input.path);
            const response = await grepFilesTool(input, {
                cwd: workspace.root,
                root: workspace.root,
            });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.grep,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const summary = {
                pattern: input.pattern,
                scope: input.path ?? ".",
                ...textSummary(response.content),
            };
            logToolCall(config, {
                tool: toolNames.grep,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.grep,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: { content: response.content },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                    ...summary,
                },
            };
        });
        registerAppTool(server, toolNames.glob, {
            title: "Glob",
            description: "Find files by glob pattern in a workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe(workspaceIdDescription),
                pattern: z.string().describe("File glob pattern."),
                path: z
                    .string()
                    .optional()
                    .describe("Optional path scope relative to the workspace root."),
            },
            outputSchema: resultOutputSchema({
                pattern: z.string(),
                scope: z.string(),
                lines: z.number(),
                characters: z.number(),
            }),
            ...toolWidgetDescriptorMeta(config, "search"),
            annotations: { readOnlyHint: true },
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            if (input.path)
                workspaces.resolvePath(workspace, input.path);
            const response = await findFilesTool(input, {
                cwd: workspace.root,
                root: workspace.root,
            });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.glob,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const summary = {
                pattern: input.pattern,
                scope: input.path ?? ".",
                ...textSummary(response.content),
            };
            logToolCall(config, {
                tool: toolNames.glob,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.glob,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: { content: response.content },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                    ...summary,
                },
            };
        });
        registerAppTool(server, toolNames.ls, {
            title: "Ls",
            description: "List a directory in a workspace. Use this for directory inspection before reading files.",
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe(workspaceIdDescription),
                path: z
                    .string()
                    .describe("Directory path to list, relative to the workspace root."),
            },
            outputSchema: resultOutputSchema({
                lines: z.number(),
                characters: z.number(),
            }),
            ...toolWidgetDescriptorMeta(config, "directory"),
            annotations: { readOnlyHint: true },
        }, async ({ workspaceId, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            workspaces.resolvePath(workspace, input.path);
            const response = await listDirectoryTool(input, {
                cwd: workspace.root,
                root: workspace.root,
            });
            if (response.isError) {
                logFailedToolResponse(config, {
                    tool: toolNames.ls,
                    workspaceId,
                    path: input.path,
                }, response.content, startedAt);
                return response;
            }
            const summary = textSummary(response.content);
            logToolCall(config, {
                tool: toolNames.ls,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return {
                ...response,
                _meta: {
                    tool: toolNames.ls,
                    card: {
                        workspaceId,
                        path: input.path,
                        summary,
                        payload: { content: response.content },
                    },
                },
                structuredContent: {
                    result: contentText(response.content),
                    ...summary,
                },
            };
        });
    }
    if (config.toolMode !== "codex") {
        registerAppTool(server, toolNames.shell, {
            title: "Bash",
            description: "Returns within 10 seconds with output and exit status, or running=true and sessionId for write_stdin polling/cancellation. The execution timeout does not limit the HTTP yield window. " + (config.toolMode !== "full"
                ? `Run a shell command in a workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. This is powerful execution and should only be exposed behind strong authentication.`
                : `Run a shell command in a workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. This is powerful execution and should only be exposed behind strong authentication.`),
            inputSchema: {
                workspaceId: z
                    .string()
                    .describe(workspaceIdDescription),
                command: z
                    .string()
                    .describe(`Shell command to run. Must not create or modify project files; use ${toolNames.edit} or ${toolNames.write} for file changes.`),
                workingDirectory: z
                    .string()
                    .optional()
                    .describe("Optional working directory relative to the workspace root. Defaults to the workspace root."),
                timeout: z
                    .number()
                    .positive()
                    .max(BASH_TOOL_MAX_TIMEOUT_SECONDS)
                    .optional()
                    .describe(`Actual execution deadline in seconds, preserved across polls. Defaults to ${BASH_TOOL_DEFAULT_TIMEOUT_SECONDS}, max ${BASH_TOOL_MAX_TIMEOUT_SECONDS}.`),
            },
            outputSchema: processOutputSchema(),
            ...toolWidgetDescriptorMeta(config, "shell"),
            annotations: SHELL_TOOL_ANNOTATIONS,
        }, async ({ workspaceId, workingDirectory, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);
            const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
            const snapshot = await processSessions.start({
                workspaceId,
                command: input.command,
                cwd,
                workspaceRoot: workspace.root,
                timeoutSeconds: input.timeout ?? BASH_TOOL_DEFAULT_TIMEOUT_SECONDS,
                shellConfig: getShellConfig(),
            });
            logToolCall(config, {
                tool: toolNames.shell,
                workspaceId,
                workingDirectory: workingDirectory ?? ".",
                command: input.command,
                commandLength: input.command.length,
                success: snapshot.running || (!snapshot.timedOut && !snapshot.signal && snapshot.exitCode === 0),
                running: snapshot.running,
                exitCode: snapshot.exitCode,
                timedOut: snapshot.timedOut,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return processToolResponse(toolNames.shell, workspaceId, snapshot, {
                command: input.command,
                workingDirectory: workingDirectory ?? ".",
                running: snapshot.running,
                exitCode: snapshot.exitCode,
                wallTimeMs: snapshot.wallTimeMs,
            });
        });
    }
    registerProcessTools(server, config, workspaces, processSessions);
    if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
        registerArtifactTools(server, {
            config,
            workspaces,
            incomingArtifactAdapters,
        });
    }
    return server;
}
export function createServer(config = loadConfig(), options = {}) {
    const incomingArtifactAdapters = options.incomingArtifactAdapters
        ?? [createOpenAIIncomingArtifactAdapter()];
    const allowedHosts = config.allowedHosts.includes("*")
        ? undefined
        : Array.from(new Set([config.host, ...config.allowedHosts]));
    const app = createMcpExpressApp({
        host: config.host,
        ...(allowedHosts ? { allowedHosts } : {}),
    });
    const issuerUrl = new URL(config.publicBaseUrl);
    const mcpUrl = new URL("/mcp", issuerUrl);
    const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
    const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir, issuerUrl);
    const oauthMetadata = createOAuthMetadata({
        provider: oauthProvider,
        issuerUrl,
        baseUrl: issuerUrl,
        scopesSupported: config.oauth.scopes,
    });
    oauthMetadata.authorization_response_iss_parameter_supported = true;
    const bearerAuth = requireBearerAuth({
        verifier: oauthProvider,
        requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    });
    const workspaceStore = createWorkspaceStore(config.stateDir);
    const workspaces = new WorkspaceRegistry(config, workspaceStore);
    const reviewCheckpoints = createReviewCheckpointManager();
    const processSessions = new ProcessSessionManager();
    const localAgentProviders = buildLocalAgentProviderStatuses(config.subagents, getLocalAgentProviderAvailabilitySnapshot());
    const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(config.subagents, getLocalAgentProviderAvailabilitySnapshot());
    if (config.logging.trustProxy) {
        app.set("trust proxy", 1);
    }
    app.use((req, res, next) => {
        const requestId = randomUUID();
        const startedAt = performance.now();
        res.locals.requestId = requestId;
        res.on("finish", () => {
            const path = requestPath(req);
            if (!config.logging.requests)
                return;
            if (!config.logging.assets && path.startsWith("/mcp-app-assets"))
                return;
            logEvent(config.logging, "info", "http_request", {
                requestId,
                method: req.method,
                path,
                status: res.statusCode,
                durationMs: Math.round(performance.now() - startedAt),
                ...requestLogFields(req, config),
            });
        });
        res.on("close", () => {
            if (res.writableFinished || !config.logging.requests)
                return;
            const path = requestPath(req);
            if (!config.logging.assets && path.startsWith("/mcp-app-assets"))
                return;
            logEvent(config.logging, "warn", "http_response_incomplete", {
                requestId,
                method: req.method,
                path,
                status: res.statusCode,
                durationMs: Math.round(performance.now() - startedAt),
                ...requestLogFields(req, config),
            });
        });
        next();
    });
    // Local patch (not upstream): ChatGPT strict-discovery GET aliases and
    // RFC 9207 authorization-response issuer support.
    // Bare PRM serves the identical doc as PRM/mcp; AS/mcp serves the
    // identical doc as bare AS. Pure GET req.url rewrite before the SDK auth
    // router, so canonical metadataHandler serves both (identical body,
    // content-type, CORS, query passthrough). No auth/token/funnel change.
    // Upgrade-clobber risk: npm upgrade overwrites dist/server.js; reapply
    // via ~/.devspace/reapply-wellknown-aliases.sh. See router.js:96-99
    // (mcpAuthMetadataRouter serves only path-specific PRM + bare AS).
    app.use((req, _res, next) => {
        if (req.method !== "GET")
            return next();
        const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
        if (req.path === "/.well-known/oauth-protected-resource")
            req.url = "/.well-known/oauth-protected-resource/mcp" + q;
        else if (req.path === "/.well-known/oauth-authorization-server/mcp")
            req.url = "/.well-known/oauth-authorization-server" + q;
        next();
    });
    app.get("/.well-known/oauth-authorization-server", (_req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.json(oauthMetadata);
    });
    app.options("/.well-known/oauth-protected-resource", (_req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.sendStatus(204);
    });
    // RFC 9207 requires the iss parameter on authorization-response redirects,
    // including the SDK's error redirects, which bypass the provider's success
    // path. Wrap res.redirect for the authorize endpoint and add the issuer
    // when the redirect target omits it.
    app.use("/authorize", (req, res, next) => {
        const originalRedirect = res.redirect.bind(res);
        // Express has two forms: redirect(url) and redirect(status, url).
        // Both must pass through intact; only the URL gains the iss parameter.
        res.redirect = (...args) => {
            let status = args.length === 2 ? args[0] : undefined;
            let url = args[args.length - 1];
            try {
                const target = new URL(String(url), issuerUrl);
                if (!target.searchParams.has("iss")) {
                    target.searchParams.set("iss", issuerUrl.href);
                    url = target.toString();
                }
            }
            catch { }
            return status === undefined ? originalRedirect(url) : originalRedirect(status, url);
        };
        next();
    });
    app.use(mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl,
        baseUrl: issuerUrl,
        resourceServerUrl,
        scopesSupported: config.oauth.scopes,
        resourceName: "DevSpace",
    }));
    app.options("/mcp-app-assets/{*asset}", (_req, res) => {
        setAssetHeaders(res);
        res.sendStatus(204);
    });
    app.use("/mcp-app-assets", express.static(uiBuildDirectory(), {
        immutable: true,
        maxAge: "1y",
        fallthrough: false,
        setHeaders: setAssetHeaders,
    }));
    app.get("/healthz", (_req, res) => {
        res.json({ ok: true, name: "devspace" });
    });
    app.all("/mcp", async (req, res) => {
        const requestId = res.locals.requestId;
        if (req.method === "GET" || req.method === "DELETE") {
            res.setHeader("Allow", "POST");
            sendJsonRpcError(res, 405, -32000, "Method not allowed; this server is stateless and only supports POST /mcp");
            return;
        }
        await new Promise((resolve, reject) => {
            bearerAuth(req, res, (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        });
        if (res.headersSent)
            return;
        if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
            logEvent(config.logging, "warn", "auth_denied", {
                requestId,
                method: req.method,
                path: requestPath(req),
                reason: "invalid_oauth_resource",
                ...requestLogFields(req, config),
            });
            sendJsonRpcError(res, 401, -32001, "Unauthorized");
            return;
        }
        logEvent(config.logging, "debug", "mcp_request", {
            requestId,
            method: req.method,
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = createMcpServer(config, workspaces, reviewCheckpoints, processSessions, resolveLocalAgentProviders, incomingArtifactAdapters);
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            logEvent(config.logging, "error", "mcp_request_error", {
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
            if (!res.headersSent) {
                sendJsonRpcError(res, 500, -32603, "Internal server error");
            }
        }
        finally {
            await transport.close().catch(() => { });
            await server.close().catch(() => { });
        }
    });
    let closePromise;
    return {
        app,
        config,
        localAgentProviders,
        close: () => {
            closePromise ??= (async () => {
                await processSessions.shutdown();
                oauthProvider.close();
                workspaceStore.close?.();
            })();
            return closePromise;
        },
    };
}
