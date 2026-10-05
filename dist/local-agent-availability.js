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
