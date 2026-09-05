import { AcpLocalAgentDriver, resolveAcpCommand, resolveAcpModelConfigUpdate, resolveAcpEffortConfigUpdate, } from "./local-agent-acp.js";
import { ClaudeLocalAgentDriver, claudeCommandEnvironment, } from "./local-agent-claude.js";
import { CodexLocalAgentDriver } from "./local-agent-codex.js";
import { OpencodeLocalAgentDriver, extractOpenCodeFinalResponse, } from "./local-agent-opencode.js";
import { PiLocalAgentDriver, extractPiFinalResponse, extractPiProviderError, } from "./local-agent-pi.js";
export function createLocalAgentDrivers(options = {}) {
    return [
        new CodexLocalAgentDriver(options.env),
        new ClaudeLocalAgentDriver(options.claudeQueryFactory, options.env),
        new OpencodeLocalAgentDriver(options.opencodeFactory),
        new PiLocalAgentDriver(options.piSessionFactory),
        new AcpLocalAgentDriver("cursor", options.env),
        new AcpLocalAgentDriver("copilot", options.env),
        new AcpLocalAgentDriver("grok", options.env),
    ];
}
export function createLocalAgentAdapter(provider, options = {}) {
    switch (provider) {
        case "codex": return new CodexLocalAgentDriver(options.env);
        case "claude": return new ClaudeLocalAgentDriver(options.claudeQueryFactory, options.env);
        case "opencode": return new OpencodeLocalAgentDriver(options.opencodeFactory);
        case "pi": return new PiLocalAgentDriver(options.piSessionFactory);
        case "cursor":
        case "copilot":
        case "grok":
            return new AcpLocalAgentDriver(provider, options.env);
    }
}
export function extractLocalAgentResponseText(value) {
    return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}
export { claudeCommandEnvironment, extractOpenCodeFinalResponse, extractPiFinalResponse, extractPiProviderError, resolveAcpCommand, resolveAcpModelConfigUpdate, resolveAcpEffortConfigUpdate, };
