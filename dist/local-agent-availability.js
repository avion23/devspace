import { accessSync, constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import { LOCAL_AGENT_PROVIDERS, } from "./local-agent-profiles.js";
export function getLocalAgentProviderAvailabilitySnapshot(env = process.env) {
    return LOCAL_AGENT_PROVIDERS.map((provider) => checkLocalAgentProviderAvailability(provider, env));
}
export function checkLocalAgentProviderAvailability(provider, env = process.env) {
    switch (provider) {
        case "codex":
            return codexAvailability(env);
        case "claude":
            return packageAvailability(provider, "@anthropic-ai/claude-agent-sdk");
        case "opencode":
            return packageAvailability(provider, "@opencode-ai/sdk/v2");
        case "pi":
            return packageAvailability(provider, "@earendil-works/pi-coding-agent");
        case "cursor":
            return commandAvailability(provider, env.CURSOR_COMMAND ?? "cursor-agent", env);
        case "copilot":
            return commandAvailability(provider, env.COPILOT_COMMAND ?? "copilot", env);
        case "grok":
            return commandAvailability(provider, env.GROK_COMMAND ?? "grok", env);
    }
}
export function assertLocalAgentProviderAvailable(provider, env = process.env) {
    const availability = checkLocalAgentProviderAvailability(provider, env);
    if (availability.available)
        return;
    throw new Error(`${provider} provider is not available: ${availability.reason ?? "provider preflight failed"}`);
}
export function formatLocalAgentProviderAvailabilitySummary(providers) {
    const available = providers
        .filter((provider) => provider.available)
        .map(formatAvailableProvider);
    const unavailable = providers
        .filter((provider) => !provider.available)
        .map((provider) => `${provider.name} (${provider.reason ?? "unavailable"})`);
    return [
        available.length > 0 ? `available: ${available.join(", ")}` : undefined,
        unavailable.length > 0 ? `unavailable: ${unavailable.join(", ")}` : undefined,
    ].filter(Boolean).join("; ");
}
function packageAvailability(provider, packageName) {
    try {
        import.meta.resolve(packageName);
        return { name: provider, available: true };
    }
    catch {
        return {
            name: provider,
            available: false,
            reason: `${packageName} package not found`,
        };
    }
}
function codexAvailability(env) {
    const availability = commandAvailability("codex", env.CODEX_COMMAND ?? "codex", env);
    return availability.available
        ? {
            ...availability,
            note: "available",
        }
        : availability;
}
function commandAvailability(provider, command, env) {
    if (resolveCommand(command, env))
        return { name: provider, available: true };
    return {
        name: provider,
        available: false,
        reason: `${command} executable not found`,
    };
}
function resolveCommand(command, env) {
    if (command.includes("/") || command.includes("\\")) {
        return executableExists(command) ? command : undefined;
    }
    const path = env.PATH;
    if (!path)
        return undefined;
    const extensions = process.platform === "win32"
        ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
        : [""];
    for (const directory of path.split(delimiter)) {
        if (!directory)
            continue;
        for (const extension of extensions) {
            const candidate = resolve(directory, `${command}${extension}`);
            if (executableExists(candidate))
                return candidate;
        }
    }
    return undefined;
}
function formatAvailableProvider(provider) {
    return provider.note ? `${provider.name} (${provider.note})` : provider.name;
}
function executableExists(command) {
    const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
    try {
        accessSync(command, mode);
        return true;
    }
    catch {
        return false;
    }
}
