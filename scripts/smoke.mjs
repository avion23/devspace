#!/usr/bin/env node
// End-to-end check of a devspace package directory (default: this checkout).
// Starts `devspace serve` on a free port with a temporary HOME, runs the OAuth
// flow and the MCP tools ChatGPT uses, then checks the shutdown drain.
// Usage: node scripts/smoke.mjs [package-dir]
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const PKG = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const SDK = `${PKG}/node_modules/@modelcontextprotocol/sdk/dist/esm/client`;
const { Client } = await import(`${SDK}/index.js`);
const { StreamableHTTPClientTransport } = await import(`${SDK}/streamableHttp.js`);

const ok = (pass, message) => {
    console.log(`${pass ? "PASS" : "FAIL"} ${message}`);
    if (!pass)
        process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolvePort(port));
    });
});

function startServer(base, repo, port) {
    const url = `http://127.0.0.1:${port}`;
    const owner = "smoke-owner-token-0123456789";
    const env = {
        ...process.env,
        HOME: join(base, "home"),
        DEVSPACE_STATE_DIR: join(base, "state"),
        DEVSPACE_OAUTH_OWNER_TOKEN: owner,
        DEVSPACE_ALLOWED_ROOTS: repo,
        DEVSPACE_PUBLIC_BASE_URL: url,
        PORT: String(port),
    };
    const child = spawn(process.execPath, [`${PKG}/dist/cli.js`, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const server = { child, url, owner, log: "", exit: null };
    child.stdout.on("data", (d) => server.log += d);
    child.stderr.on("data", (d) => server.log += d);
    child.on("exit", (code) => server.exit = { code, at: Date.now() });
    return server;
}

async function waitListening(server) {
    for (let i = 0; i < 100 && !server.log.includes("listening") && !server.exit; i++)
        await sleep(100);
    return server.log.includes("listening");
}

async function authorize(server) {
    const redirect = "http://127.0.0.1:9/cb";
    const reg = await (await fetch(`${server.url}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "smoke", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
    })).json();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const resource = `${server.url}/mcp`;
    const az = await fetch(`${server.url}/authorize`, {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({ client_id: reg.client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource, state: "s", scope: "devspace", owner_token: server.owner }),
    });
    const code = new URL(az.headers.get("location")).searchParams.get("code");
    const token = await (await fetch(`${server.url}/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect, resource }),
    })).json();
    return token.access_token;
}

const text = (result) => result.content.map((item) => item.text ?? "").join("");

function checkNotDuplicated(result, label) {
    const body = text(result);
    const structured = JSON.stringify(result.structuredContent ?? {});
    ok(body.length < 40 || !structured.includes(body.slice(0, 40)), `${label}: output not duplicated in structuredContent (${structured.length}B structured, ${body.length}B text)`);
}

async function checkTools(server, repo) {
    ok(readFileSync(`/proc/${server.child.pid}/comm`, "utf8").trim() === "devspace-serve", "process title devspace-serve");
    ok((await fetch(`${server.url}/mcp`)).status === 405, "GET /mcp returns 405");
    const token = await authorize(server);
    ok(Boolean(token), "OAuth flow issues an access token");
    const connect = async () => {
        const client = new Client({ name: "smoke", version: "1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
        return client;
    };
    const first = await connect();
    const second = await connect();
    try {
        const tools = (await first.listTools()).tools.map((tool) => tool.name);
        ok(["exec_command", "write_stdin", "edit", "write", "read"].every((name) => tools.includes(name)), `tools: ${tools.join(",")}`);
        const opened = await first.callTool({ name: "open_workspace", arguments: { path: repo } });
        const workspaceId = opened.structuredContent?.workspaceId;
        ok(Boolean(workspaceId), `open_workspace returns ${workspaceId}`);
        checkNotDuplicated(opened, "open_workspace");
        const written = await second.callTool({ name: "write", arguments: { workspaceId, path: "a.txt", content: "hello\n".repeat(50) } });
        ok(!written.isError, "second client uses the workspace (stateless transport)");
        checkNotDuplicated(await first.callTool({ name: "read", arguments: { workspaceId, path: "a.txt" } }), "read");

        const started = Date.now();
        const long = await first.callTool({ name: "exec_command", arguments: { workspaceId, cmd: "echo start; sleep 40; echo done" } }, undefined, { timeout: 120_000 });
        const seconds = (Date.now() - started) / 1000;
        ok(seconds <= 31 && long.structuredContent?.running === true, `exec_command yields in ${seconds.toFixed(1)}s with running=true`);
        checkNotDuplicated(long, "exec_command");
        let final;
        for (let polls = 1; ; polls++) {
            const poll = await first.callTool({ name: "write_stdin", arguments: { workspaceId, sessionId: long.structuredContent.sessionId } }, undefined, { timeout: 120_000 });
            if (poll.structuredContent?.running)
                continue;
            final = poll;
            ok(text(final).includes("done") && final.structuredContent.exitCode === 0, `write_stdin polls to exit 0 (${polls} polls)`);
            break;
        }

        const big = await first.callTool({ name: "exec_command", arguments: { workspaceId, cmd: "seq 1 1000000" } }, undefined, { timeout: 120_000 });
        let bigText = text(big);
        let state = big.structuredContent;
        while (state?.running) {
            const poll = await first.callTool({ name: "write_stdin", arguments: { workspaceId, sessionId: state.sessionId } }, undefined, { timeout: 120_000 });
            bigText += text(poll);
            state = poll.structuredContent;
        }
        const logPath = bigText.match(/logged at (\S+)/)?.[1];
        ok(bigText.length < 20_000, `large output bounded to ${bigText.length} chars`);
        ok(Boolean(logPath) && existsSync(logPath) && readFileSync(logPath, "utf8").trim().split("\n").length === 1_000_000, `full output kept in ${logPath}`);
        ok(bigText.includes("1000000"), "tail of large output present");
        return { token, workspaceId };
    }
    finally {
        await first.close();
        await second.close();
    }
}

// A keep-alive connection with one in-flight call; SIGTERM must let that call
// finish with 200, refuse new connections, and exit 0 before the 35 s deadline.
async function checkShutdownDrain(server, token, workspaceId) {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const rpc = (id, name, args) => new Promise((resolveCall) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
        const request = http.request(`${server.url}/mcp`, { method: "POST", agent, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (response) => {
            response.resume();
            response.on("end", () => resolveCall({ status: response.statusCode }));
        });
        request.on("error", (error) => resolveCall({ status: error.code }));
        request.end(body);
    });
    const inFlight = rpc(1, "exec_command", { workspaceId, cmd: "sleep 20" });
    await sleep(1500);
    const signalled = Date.now();
    server.child.kill("SIGTERM");
    await sleep(300);
    const fresh = await fetch(`${server.url}/healthz`).then((r) => r.status, (error) => error.cause?.code ?? "error");
    const drained = await inFlight;
    for (let i = 0; i < 200 && !server.exit; i++)
        await sleep(200);
    ok(drained.status === 200, `in-flight call during shutdown returns ${drained.status}`);
    ok(fresh === "ECONNREFUSED", `new connection during shutdown: ${fresh}`);
    ok(server.exit?.code === 0 && server.exit.at - signalled < 35_000, `exits ${server.exit?.code} after ${server.exit ? ((server.exit.at - signalled) / 1000).toFixed(1) : "-"}s`);
    agent.destroy();
}

const base = mkdtempSync(join(tmpdir(), "devspace-smoke-"));
const repo = join(base, "repo");
mkdirSync(join(base, "home"));
mkdirSync(repo);
execSync("git init -q && git -c user.email=smoke@localhost -c user.name=smoke commit -q --allow-empty -m init", { cwd: repo });
const server = startServer(base, repo, await freePort());
try {
    ok(await waitListening(server), `server starts from ${PKG}`);
    const { token, workspaceId } = await checkTools(server, repo);
    await checkShutdownDrain(server, token, workspaceId);
    ok(!/Internal server error|ERR_ERL_/.test(server.log), "no server errors logged");
}
catch (error) {
    ok(false, `exception: ${error?.stack ?? error}`);
}
finally {
    if (!server.exit)
        server.child.kill("SIGKILL");
    if (process.exitCode)
        console.log(`server log:\n${server.log.split("\n").slice(-30).join("\n")}`);
    rmSync(base, { recursive: true, force: true });
}
