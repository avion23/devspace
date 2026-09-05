import { LOCAL_AGENT_PROVIDERS, } from "./local-agent-profiles.js";
export const SUBAGENT_SKILL_INSTALL_COMMAND = "npx skills add Waishnav/devspace --skill subagents --global";
export const ONBOARDING_DESTINATIONS = ["chatgpt", "coding-agents"];
export function resolveOnboardingUsage(destinations) {
    const selected = new Set(destinations);
    if (selected.has("chatgpt") && selected.has("coding-agents"))
        return "both";
    if (selected.has("chatgpt"))
        return "chatgpt";
    if (selected.has("coding-agents"))
        return "coding-agents";
    throw new Error("Choose ChatGPT, Coding Agents, or both.");
}
export function usesChatGpt(usage) {
    return usage === "chatgpt" || usage === "both";
}
export function usesCodingAgents(usage) {
    return usage === "coding-agents" || usage === "both";
}
export function updateOnboardingSubagentsConfig(current, selectedProviders) {
    const selected = new Set(selectedProviders);
    return {
        enabled: true,
        providers: LOCAL_AGENT_PROVIDERS
            .filter((id) => selected.has(id) || current.providers.some((provider) => provider.id === id))
            .map((id) => {
            const existing = current.providers.find((provider) => provider.id === id);
            return {
                ...existing,
                id,
                enabled: selected.has(id),
            };
        }),
    };
}
