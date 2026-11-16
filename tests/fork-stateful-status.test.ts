import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProxyOptions } from "../src/config.ts";

const root = mkdtempSync(path.join(tmpdir(), "bili-stateful-status-"));
for (const name of ["STATE", "CACHE", "DATA", "CONFIG"]) {
    process.env[`XDG_${name}_HOME`] = path.join(root, name.toLowerCase());
}
const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { loadRoutes } = await import("../src/config.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { _resetSessionsForTest } = await import("../src/session.ts");

type Wire = "openai" | "anthropic" | "responses" | "google";
const LIMIT = 872_000;
const statusMarker = "[ACP status: highest allocated ref";
const messages = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `${i}: ` + "context work baseline history ".repeat(850),
}));

function requestBody(wire: Wire, round: number): Record<string, unknown> {
    const history = [...messages, ...Array.from({ length: round }, (_, i) => [
        { role: "user", content: `Continue task ${i}.` },
        { role: "assistant", content: `Completed task ${i}.` },
    ]).flat(), { role: "user", content: `Next step ${round}.` }];
    if (wire === "google") return {
        contents: history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: 1000 },
    };
    if (wire === "responses") return { model: "test", input: history, max_output_tokens: 1000 };
    return { model: "test", max_tokens: 1000, messages: history };
}

const endpoints: Record<Wire, string> = {
    openai: "/v1/chat/completions",
    anthropic: "/v1/messages",
    responses: "/v1/responses",
    google: "/v1beta/models/test:generateContent",
};

async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
}

async function exercise(wire: Wire, renderNone: boolean, pluginMode = false, injectNudge = false): Promise<void> {
    const seen: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            seen.push(Buffer.concat(chunks).toString());
            res.writeHead(200, { "content-type": "application/json" });
            if (wire === "anthropic") res.end(JSON.stringify({ id: "msg-test", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 600_000, output_tokens: 1 } }));
            else if (wire === "google") res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 600_000, candidatesTokenCount: 1 } }));
            else if (wire === "responses") res.end(JSON.stringify({ id: "resp-test", object: "response", status: "completed", model: "test", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 600_000, output_tokens: 1 } }));
            else res.end(JSON.stringify({ id: "chatcmpl-test", object: "chat.completion", model: "test", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 600_000, completion_tokens: 1, total_tokens: 600_001 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const configPath = path.join(root, `${wire}-${renderNone}-${pluginMode}.json`);
    writeFileSync(configPath, JSON.stringify({ autoUpdate: false, providers: { [url]: { renderNone } }, compress: { tiers: false, nudgeGrowthTokens: 50_000 } }));
    process.env.BILI_CONFIG_FILE = configPath;
    delete process.env.ACP_RENDER_NONE;
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const cfg = defaultConfig(LIMIT);
    cfg.preserveRecentMessages = 0;
    cfg.preserveRecentTokens = 0;
    const opts: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: url, routes: loadRoutes(), proxy: "", proxyMode: "direct", proxySource: "direct",
        modelContextLimit: LIMIT, kernelConfig: cfg,
        compress: { injectTool: true, injectNudge }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, chainContentDetection: false, passthroughSource: null,
        compat: { roles: {} }, streamErrorShape: "protocol", autoRestartOnUpdate: false, updateTag: "latest",
        advisoryCheck: false, releaseNotesCheck: false, autoUpdate: false, mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    try {
        const port = (proxy.address() as { port: number }).port;
        for (let round = 0; round < 4; round++) {
            const res = await fetch(`http://127.0.0.1:${port}${endpoints[wire]}`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-session-id": `status-${wire}-${renderNone}-${pluginMode}`, ...(pluginMode ? { "x-bili-plugin": "dsh" } : {}) },
                body: JSON.stringify(requestBody(wire, round)),
            });
            assert.equal(res.status, 200, await res.text());
        }
        assert.equal(seen.length, 4, "all consecutive requests reached the fake upstream");
        if (injectNudge) {
            assert.ok(seen.some((body, round) => JSON.parse(body).messages.length > (requestBody(wire, round).messages as unknown[]).length), "the full nudge still reaches the upstream on renderNone routes");
            assert.ok(seen.some((body) => JSON.parse(body).tools.some((tool: { name: string }) => tool.name === "compress")), "the compress tool remains available");
        }
        if (renderNone) {
            for (const body of seen) assert.ok(!body.includes(statusMarker), "renderNone never appends a moving status footer");
        } else {
            assert.ok(seen.some((body) => body.includes(statusMarker)), "control route reaches the armed status window and retains its footer");
        }
    } finally {
        await close(proxy);
        await close(upstream);
    }
}

for (const wire of ["openai", "anthropic", "responses", "google"] as const) {
    for (const renderNone of [false, true]) {
        test(`stateful status: ${wire} renderNone=${renderNone}`, { timeout: 90_000 }, () => exercise(wire, renderNone));
    }
}
for (const renderNone of [false, true]) {
    test(`stateful status: native plugin Anthropic renderNone=${renderNone}`, { timeout: 90_000 }, () => exercise("anthropic", renderNone, true));
}
test("stateful status: renderNone retains the full nudge and compression tools", { timeout: 90_000 }, () => exercise("anthropic", true, false, true));
test.after(() => {
    delete process.env.BILI_CONFIG_FILE;
    rmSync(root, { recursive: true, force: true });
});
