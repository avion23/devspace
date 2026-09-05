import { isLocalAgentProvider, LOCAL_AGENT_PROVIDERS, } from "./local-agent-profiles.js";
export function parseLocalAgentRunArgs(args) {
    const parsed = parseAgentPromptArgs(args, 'Usage: devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] "<prompt>"');
    return parsed;
}
export function parseLocalAgentContinueArgs(args) {
    const parsed = parseAgentPromptArgs(args, 'Usage: devspace agents continue <id> [--model <model>] [--effort <level>] "<prompt>"');
    return { agentId: parsed.target, prompt: parsed.prompt, model: parsed.model, effort: parsed.effort };
}
function parseAgentPromptArgs(args, usage) {
    const [target, ...rest] = args;
    if (!target) {
        throw new Error(usage);
    }
    let model;
    let effort;
    const promptParts = [];
    let optionsEnded = false;
    for (let index = 0; index < rest.length; index += 1) {
        const part = rest[index];
        if (!optionsEnded && part === "--") {
            optionsEnded = true;
            continue;
        }
        if (optionsEnded) {
            promptParts.push(part ?? "");
            continue;
        }
        if (part === "--model") {
            const value = parseOptionValue(rest[index + 1], "--model");
            model = value;
            index += 1;
            continue;
        }
        if (part?.startsWith("--model=")) {
            const value = parseOptionValue(part.slice("--model=".length), "--model");
            model = value;
            continue;
        }
        if (part === "--effort") {
            const value = parseOptionValue(rest[index + 1], "--effort");
            effort = value;
            index += 1;
            continue;
        }
        if (part?.startsWith("--effort=")) {
            const value = parseOptionValue(part.slice("--effort=".length), "--effort");
            effort = value;
            continue;
        }
        if (part?.startsWith("-")) {
            throw unknownOptionError(part);
        }
        promptParts.push(part ?? "");
    }
    const prompt = promptParts.join(" ").trim();
    if (!prompt) {
        throw new Error(usage);
    }
    return { target, prompt, model, effort };
}
function parseOptionValue(value, option) {
    const trimmed = value?.trim();
    if (!trimmed)
        throw new Error(`Missing value for ${option}.`);
    if (trimmed.startsWith("-"))
        throw unknownOptionError(trimmed);
    return trimmed;
}
function unknownOptionError(option) {
    return new Error(`Unknown option: ${option}. Use -- before prompt text that starts with a dash.`);
}
export function resolveLocalAgentTarget(target, profiles, modelOverride, effortOverride, providerConfigs = []) {
    const profile = profiles.find((candidate) => candidate.name === target);
    if (profile) {
        const providerConfig = providerConfigs.find((entry) => entry.id === profile.provider);
        return {
            kind: "profile",
            name: profile.name,
            provider: profile.provider,
            model: modelOverride ?? profile.model ?? providerConfig?.model,
            effort: effortOverride ?? profile.effort ?? providerConfig?.effort,
            profile,
        };
    }
    if (isLocalAgentProvider(target)) {
        const providerConfig = providerConfigs.find((entry) => entry.id === target);
        return {
            kind: "provider",
            name: target,
            provider: target,
            model: modelOverride ?? providerConfig?.model,
            effort: effortOverride ?? providerConfig?.effort,
        };
    }
    return undefined;
}
export function formatAvailableLocalAgentTargets(profiles) {
    const profileNames = profiles.map((profile) => profile.name);
    const parts = [
        profileNames.length > 0 ? `profiles: ${profileNames.join(", ")}` : undefined,
        `providers: ${LOCAL_AGENT_PROVIDERS.join(", ")}`,
    ].filter(Boolean);
    return parts.join("; ");
}
