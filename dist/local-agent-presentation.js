export function presentAgentTargetCatalog(catalog) {
    return {
        targets: [
            ...catalog.providers
                .filter((provider) => provider.usable)
                .map((provider) => ({
                name: provider.id,
                kind: "provider",
                ...(provider.model ? { model: provider.model } : {}),
                ...(provider.effort ? { effort: provider.effort } : {}),
            })),
            ...catalog.profiles.map((profile) => ({
                name: profile.name,
                kind: "profile",
                provider: profile.provider,
                description: profile.description,
                ...(profile.model ? { model: profile.model } : {}),
                ...(profile.effort ? { effort: profile.effort } : {}),
            })),
        ],
    };
}
export function presentAgentReceipt(record) {
    return { id: record.id, status: presentAgentStatus(record.status) };
}
export function presentAgentSummary(record) {
    return { ...presentAgentReceipt(record), target: record.profileName };
}
export function presentAgentObservation(record) {
    const receipt = presentAgentReceipt(record);
    switch (receipt.status) {
        case "completed":
            return {
                ...receipt,
                status: "completed",
                ...(record.latestResponse === undefined ? {} : { response: record.latestResponse }),
            };
        case "failed":
            return { ...receipt, status: "failed", error: presentAgentFailure(record) };
        case "stopped":
            return {
                ...receipt,
                status: "stopped",
                ...(hasAgentFailure(record) ? { error: presentAgentFailure(record) } : {}),
            };
        case "running":
            return { id: receipt.id, status: "running" };
    }
}
export function formatAgentTargetCatalog(catalog) {
    if (catalog.targets.length === 0)
        return "No usable subagent targets.";
    return catalog.targets.map((target) => {
        const settings = [
            target.model ? `model=${target.model}` : undefined,
            target.effort ? `effort=${target.effort}` : undefined,
        ].filter(Boolean).join(" ");
        if (target.kind === "provider") {
            return `${target.name} [provider]${settings ? ` ${settings}` : ""}`;
        }
        return `${target.name} [profile, ${target.provider}]${settings ? ` ${settings}` : ""} - ${target.description}`;
    }).join("\n");
}
export function formatAgentReceipt(receipt) {
    return `${receipt.id} ${receipt.status}`;
}
export function formatAgentSummary(summary) {
    return `${formatAgentReceipt(summary)} ${summary.target}`;
}
export function formatAgentObservation(observation) {
    const line = formatAgentReceipt(observation);
    if (observation.status === "completed" && observation.response !== undefined) {
        return `${line}\n\n${observation.response}`;
    }
    if ((observation.status === "failed" || observation.status === "stopped") && observation.error) {
        const retryable = observation.error.retryable ? " [retryable]" : "";
        return `${line} ${observation.error.code}: ${observation.error.message}${retryable}`;
    }
    return line;
}
function presentAgentStatus(status) {
    switch (status) {
        case "starting":
        case "running":
            return "running";
        case "idle":
            return "completed";
        case "error":
            return "failed";
        case "stopped":
            return "stopped";
    }
}
function hasAgentFailure(record) {
    return record.error !== undefined || record.errorCode !== undefined || record.errorRetryable !== undefined;
}
function presentAgentFailure(record) {
    return {
        code: record.errorCode ?? "AGENT_FAILED",
        message: record.error ?? "Subagent failed without an error message.",
        retryable: record.errorRetryable ?? false,
    };
}
