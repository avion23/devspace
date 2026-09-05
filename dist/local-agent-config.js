import * as z from "zod/v4";
import { LOCAL_AGENT_PROVIDERS, } from "./local-agent-profiles.js";
const providerSchema = z.object({
    id: z.enum(LOCAL_AGENT_PROVIDERS),
    enabled: z.boolean(),
    model: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
}).strict();
const subagentsSchema = z.object({
    enabled: z.boolean(),
    providers: z.array(providerSchema),
}).strict().superRefine((value, context) => {
    const seen = new Set();
    for (const [index, provider] of value.providers.entries()) {
        if (seen.has(provider.id)) {
            context.addIssue({
                code: "custom",
                path: ["providers", index, "id"],
                message: `Duplicate subagent provider: ${provider.id}`,
            });
        }
        seen.add(provider.id);
    }
});
export function resolveSubagentsConfig(value, env = process.env) {
    const stored = value === undefined
        ? { enabled: false, providers: [] }
        : typeof value === "boolean"
            ? legacySubagentsConfig(value)
            : subagentsSchema.parse(value);
    return {
        ...stored,
        enabled: env.DEVSPACE_SUBAGENTS === undefined
            ? stored.enabled
            : parseBoolean(env.DEVSPACE_SUBAGENTS),
    };
}
export function subagentProviderConfig(config, provider) {
    return config.providers.find((entry) => entry.id === provider);
}
export function isSubagentProviderEnabled(config, provider) {
    return config.enabled && subagentProviderConfig(config, provider)?.enabled === true;
}
function legacySubagentsConfig(enabled) {
    return {
        enabled,
        providers: enabled
            ? LOCAL_AGENT_PROVIDERS.map((id) => ({ id, enabled: true }))
            : [],
    };
}
function parseBoolean(value) {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
