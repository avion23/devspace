import { isLocalAgentProvider, LOCAL_AGENT_PROVIDERS, } from "./local-agent-profiles.js";
export const CODEX_DEFAULT_MODEL = "gpt-5.6-luna";
export const CODEX_DEFAULT_EFFORT = "max";
const BLOCKED_MODEL_IDS = new Set(["gpt-5.6-terra", "gpt-5-6-terra"]);
const MIN_GPT_MAJOR = 5;
const MIN_GPT_MINOR = 6;

/**
 * Returns the reason a model is refused, or undefined when it is admissible.
 * Two rules: Terra is always blocked, and any gpt-<version> model below
 * gpt-5.6 is blocked with guidance to use gpt-5.6 models.
 */
export function blockedModelReason(model) {
    if (typeof model !== "string")
        return undefined;
    const modelId = model.trim().toLowerCase().split(/[/:]/).at(-1);
    if (BLOCKED_MODEL_IDS.has(modelId))
        return "blocked";
    const match = modelId.match(/^gpt-(\d+)(?:[.-](\d+))?/);
    if (!match)
        return undefined;
    const major = Number(match[1]);
    const minor = match[2] === undefined ? 0 : Number(match[2]);
    if (major < MIN_GPT_MAJOR || (major === MIN_GPT_MAJOR && minor < MIN_GPT_MINOR))
        return "below-minimum";
    return undefined;
}
export function isBlockedLocalAgentModel(model) {
    return blockedModelReason(model) !== undefined;
}
export function blockedModelMessage(model) {
    return `Model '${model}' is blocked by DevSpace policy. Use gpt-5.6 models, e.g. gpt-5.6-luna with max thinking.`;
}
export function resolveLocalAgentSettings(provider, model, effort) {
    return {
        model: model ?? (provider === "codex" ? CODEX_DEFAULT_MODEL : undefined),
        effort: effort ?? (provider === "codex" ? CODEX_DEFAULT_EFFORT : undefined),
    };
}
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
        const settings = resolveLocalAgentSettings(profile.provider, modelOverride ?? profile.model ?? providerConfig?.model, effortOverride ?? profile.effort ?? providerConfig?.effort);
        return {
            kind: "profile",
            name: profile.name,
            provider: profile.provider,
            ...settings,
            profile,
        };
    }
    if (isLocalAgentProvider(target)) {
        const providerConfig = providerConfigs.find((entry) => entry.id === target);
        const settings = resolveLocalAgentSettings(target, modelOverride ?? providerConfig?.model, effortOverride ?? providerConfig?.effort);
        return {
            kind: "provider",
            name: target,
            provider: target,
            ...settings,
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
