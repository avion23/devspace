import { LOCAL_AGENT_PROVIDERS, } from "./local-agent-profiles.js";
import { isBlockedLocalAgentModel, resolveLocalAgentSettings, } from "./local-agent-targets.js";
export function buildLocalAgentProviderStatuses(config, availability) {
    return LOCAL_AGENT_PROVIDERS.map((id) => {
        const configured = config.providers.find((entry) => entry.id === id);
        const live = availability.find((entry) => entry.name === id);
        const enabled = configured?.enabled === true;
        const available = live?.available === true;
        const settings = resolveLocalAgentSettings(id, configured?.model, configured?.effort);
        return {
            id,
            enabled,
            available,
            usable: config.enabled && enabled && available,
            model: settings.model,
            effort: settings.effort,
            reason: live?.reason,
            note: live?.note,
        };
    });
}
export function buildLocalAgentCatalog(config, profiles, providers) {
    const visibleProviders = providers
        .filter((provider) => provider.enabled)
        .map((provider) => ({
        ...provider,
        ...resolveLocalAgentSettings(provider.id, provider.model, provider.effort),
    }));
    const usable = new Map(visibleProviders.filter((provider) => provider.usable).map((provider) => [provider.id, provider]));
    return {
        enabled: config.enabled,
        providers: visibleProviders.filter((provider) => !isBlockedLocalAgentModel(provider.model)),
        profiles: profiles
            .filter((profile) => !profile.disabled && usable.has(profile.provider))
            .map((profile) => {
            const provider = usable.get(profile.provider);
            const settings = resolveLocalAgentSettings(profile.provider, profile.model ?? provider.model, profile.effort ?? provider.effort);
            return {
                name: profile.name,
                description: profile.description,
                provider: profile.provider,
                ...settings,
            };
        })
            .filter((profile) => !isBlockedLocalAgentModel(profile.model)),
    };
}
export function formatLocalAgentProviderStatusSummary(providers) {
    return providers.map((provider) => {
        const state = provider.usable
            ? "usable"
            : !provider.enabled
                ? "disabled"
                : !provider.available
                    ? `unavailable: ${provider.reason ?? "provider preflight failed"}`
                    : "subagents disabled";
        return `${provider.id} (${state})`;
    }).join(", ");
}
