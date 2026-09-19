import { CodexLocalAgentDriver } from "./local-agent-codex.js";
export function createLocalAgentDrivers(options = {}) {
    return [
        new CodexLocalAgentDriver(options.env, options.codexCommandResolver, {
            sandboxFallback: options.sandboxFallback,
            worktreeRoot: options.worktreeRoot,
            sandboxProbe: options.sandboxProbe,
            onSandboxFallback: options.onSandboxFallback,
            sandboxProbeTtlMs: options.sandboxProbeTtlMs,
            execFile: options.execFile,
            sandboxMode: options.codexSandboxMode,
        }),
    ];
}
export function createLocalAgentAdapter(provider, options = {}) {
    if (provider !== "codex")
        return undefined;
    return new CodexLocalAgentDriver(options.env, options.codexCommandResolver, {
        sandboxFallback: options.sandboxFallback,
        worktreeRoot: options.worktreeRoot,
        sandboxProbe: options.sandboxProbe,
        onSandboxFallback: options.onSandboxFallback,
        sandboxProbeTtlMs: options.sandboxProbeTtlMs,
        execFile: options.execFile,
        sandboxMode: options.codexSandboxMode,
    });
}