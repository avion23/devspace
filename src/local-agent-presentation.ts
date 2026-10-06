import type { LocalAgentCatalog } from "./local-agent-catalog.js";
import type { LocalAgentRecord, LocalAgentStatus } from "./local-agent-store.js";

export type AgentCommandStatus = "running" | "completed" | "failed" | "stopped";

export type AgentTargetOutput =
  | {
      name: string;
      kind: "provider";
      model?: string;
      effort?: string;
    }
  | {
      name: string;
      kind: "profile";
      provider: string;
      description: string;
      model?: string;
      effort?: string;
    };

export interface AgentTargetCatalogOutput {
  targets: AgentTargetOutput[];
}

export interface AgentReceiptOutput {
  id: string;
  status: AgentCommandStatus;
}

export interface AgentSummaryOutput extends AgentReceiptOutput {
  target: string;
}

export interface AgentFailureOutput {
  code: string;
  message: string;
  retryable: boolean;
  backend?: string;
  stage?: string;
  detail?: string;
  fallback_available?: boolean;
}

export interface AgentExposureOutput {
  previouslyUnsandboxed: true;
  lastUnsandboxedAt?: string;
}

export type AgentObservationOutput =
  | ({ id: string; status: "running"; metadata?: Record<string, unknown> } & Partial<AgentExposureOutput>)
  | ({ id: string; status: "completed"; response?: string; metadata?: Record<string, unknown> } & Partial<AgentExposureOutput>)
  | ({ id: string; status: "failed"; error: AgentFailureOutput; metadata?: Record<string, unknown> } & Partial<AgentExposureOutput>)
  | ({ id: string; status: "stopped"; error?: AgentFailureOutput; metadata?: Record<string, unknown> } & Partial<AgentExposureOutput>);

export function presentAgentTargetCatalog(catalog: LocalAgentCatalog): AgentTargetCatalogOutput {
  return {
    targets: [
      ...catalog.providers
        .filter((provider) => provider.usable)
        .map((provider): AgentTargetOutput => ({
          name: provider.id,
          kind: "provider",
          ...(provider.model ? { model: provider.model } : {}),
          ...(provider.effort ? { effort: provider.effort } : {}),
        })),
      ...catalog.profiles.map((profile): AgentTargetOutput => ({
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

export function presentAgentReceipt(record: LocalAgentRecord): AgentReceiptOutput {
  return { id: record.id, status: presentAgentStatus(record.status) };
}

export function presentAgentSummary(record: LocalAgentRecord): AgentSummaryOutput {
  return { ...presentAgentReceipt(record), target: record.profileName };
}

export function presentAgentObservation(record: LocalAgentRecord): AgentObservationOutput {
  const receipt = presentAgentReceipt(record);
  switch (receipt.status) {
    case "completed":
      return {
        ...receipt,
        status: "completed",
        ...presentAgentExposure(record),
        ...(record.latestResponse === undefined ? {} : { response: record.latestResponse }),
        ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
      };
    case "failed":
      return { ...receipt, status: "failed", ...presentAgentExposure(record), error: presentAgentFailure(record), ...(record.metadata === undefined ? {} : { metadata: record.metadata }) };
    case "stopped":
      return {
        ...receipt,
        status: "stopped",
        ...presentAgentExposure(record),
        ...(hasAgentFailure(record) ? { error: presentAgentFailure(record) } : {}),
        ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
      };
    case "running":
      return {
        id: receipt.id,
        status: "running",
        ...presentAgentExposure(record),
        ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
      };
  }
}

export function formatAgentTargetCatalog(catalog: AgentTargetCatalogOutput): string {
  if (catalog.targets.length === 0) return "No usable subagent targets.";
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

export function formatAgentReceipt(receipt: AgentReceiptOutput): string {
  return `${receipt.id} ${receipt.status}`;
}

export function formatAgentSummary(summary: AgentSummaryOutput): string {
  return `${formatAgentReceipt(summary)} ${summary.target}`;
}

export function formatAgentObservation(observation: AgentObservationOutput): string {
  const line = formatAgentReceipt(observation);
  const notices = [formatAgentWarnings(observation.metadata), formatAgentExposure(observation)].filter(Boolean).join("\n");
  if (observation.status === "completed" && observation.response !== undefined) {
    return `${line}\n\n${observation.response}${notices ? `\n\n${notices}` : ""}`;
  }
  if ((observation.status === "failed" || observation.status === "stopped") && observation.error) {
    const retryable = observation.error.retryable ? " [retryable]" : "";
    return `${line} ${observation.error.code}: ${observation.error.message}${retryable}${notices ? `\n${notices}` : ""}`;
  }
  return notices ? `${line}\n${notices}` : line;
}

function presentAgentStatus(status: LocalAgentStatus): AgentCommandStatus {
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

function hasAgentFailure(record: LocalAgentRecord): boolean {
  return record.error !== undefined || record.errorCode !== undefined || record.errorRetryable !== undefined;
}

function presentAgentFailure(record: LocalAgentRecord): AgentFailureOutput {
  return {
    code: record.errorCode ?? "AGENT_FAILED",
    message: record.error ?? "Subagent failed without an error message.",
    retryable: record.errorRetryable ?? false,
    ...(record.errorBackend === undefined ? {} : { backend: record.errorBackend }),
    ...(record.errorStage === undefined ? {} : { stage: record.errorStage }),
    ...(record.errorDetail === undefined ? {} : { detail: record.errorDetail }),
    ...(record.errorFallbackAvailable === undefined ? {} : { fallback_available: record.errorFallbackAvailable }),
  };
}

function formatAgentWarnings(metadata: Record<string, unknown> | undefined): string {
  const warnings = Array.isArray(metadata?.warnings)
    ? metadata.warnings.filter((warning): warning is string => typeof warning === "string" && warning.length > 0)
    : [];
  return warnings.map((warning) => `Warning: ${warning}`).join("\n");
}

function presentAgentExposure(record: LocalAgentRecord): Partial<AgentExposureOutput> {
  if (record.previouslyUnsandboxed !== true) return {};
  return {
    previouslyUnsandboxed: true,
    ...(record.lastUnsandboxedAt === undefined ? {} : { lastUnsandboxedAt: record.lastUnsandboxedAt }),
  };
}

function formatAgentExposure(observation: Partial<AgentExposureOutput>): string {
  if (observation.previouslyUnsandboxed !== true) return "";
  return `Warning: previouslyUnsandboxed=true; lastUnsandboxedAt=${observation.lastUnsandboxedAt ?? "unknown"}.`;
}
