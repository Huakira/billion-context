import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { applyEffortPin } from "../src/effort-pin.ts";
import { loadRoutes, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// Fork-only: route-scoped effort pin (src/effort-pin.ts), plus the shared harness.
// #2483 follow-up: route-scoped render tags (`providers[<url>].renderNone`).
// A stateful claude-code relay (magpie) keyed to one upstream URL needs tags off
// while every other lane keeps them. These tests pin the forwarded bytes:
// the matching route decides, a non-matching route falls back to the global
// diagnostics flag, and ACP_RENDER_NONE still wins over both.
// (Harness copied from issue2483-render-strategy.test.ts.)
//
// Original header — #2483: the effective render strategy had two consistency holes:
//   (a) the processTurn diag line hardcoded renderTags=text-only even when
//       renderNone was active (misleading log);
//   (b) the Google lane ignored renderNone entirely — hardcoded "text-only" in
//       processTurn / Prepared / countTokens and no knob check on the #1881
//       tagsOnly gate, so ACP_RENDER_NONE was dead config on /v1beta.
// These e2e tests pin the WIRE bytes on both lanes: the default still tags
// assistant/model text (no behavior drift), and under ACP_RENDER_NONE=1 the
// forwarded assistant/model text is byte-identical to the client's and the
// NEVER-echo prompt section disappears (the tagsOnly gate follows the strategy).

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

function upstreamServer(onBody: (path: string, body: unknown) => void): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: unknown = null;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
            const url = req.url ?? "";
            onBody(url, parsed);
            res.writeHead(200, { "content-type": "application/json" });
            if (url.includes(":generateContent")) {
                res.end(JSON.stringify({
                    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
                }));
                return;
            }
            res.end(JSON.stringify({
                id: "chatcmpl-test", object: "chat.completion", created: 0, model: "test",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface Harness { port: number; stop: () => Promise<void>; cleanup: () => void }

async function startProxy(upstream: http.Server, fileConfig: (upstreamUrl: string) => unknown): Promise<Harness> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-2483-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(root, { recursive: true });
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    delete process.env.ACP_RENDER_NONE;
    delete process.env.ACP_NO_COMPRESS_PROMPT;
    const upstreamPort = (upstream.address() as { port: number }).port;
    writeFileSync(biliConfig, JSON.stringify(fileConfig(`http://127.0.0.1:${upstreamPort}`)), "utf8");
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: loadRoutes(),
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        chainContentDetection: false,
        passthroughSource: null,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    return {
        port,
        stop: async () => { await close(proxy); },
        cleanup: () => {
            delete process.env.ACP_RENDER_NONE;
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

const CHAT_BODY = JSON.stringify({
    model: "test",
    max_tokens: 1000,
    messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "what did we say?" },
    ],
});


type Msg = { role?: string; content?: unknown };

function chatAssistantText(fwd: Record<string, unknown>): string {
    const msgs = fwd.messages as Msg[] | undefined;
    assert.ok(Array.isArray(msgs), "forwarded body carries messages");
    const a = msgs.find((m) => m.role === "assistant");
    assert.ok(a, "the assistant message reaches the upstream");
    return typeof a.content === "string" ? a.content : JSON.stringify(a.content);
}

function chatSystemText(fwd: Record<string, unknown>): string {
    const msgs = fwd.messages as Msg[] | undefined;
    assert.ok(Array.isArray(msgs), "forwarded body carries messages");
    const sys = msgs.find((m) => m.role === "system");
    assert.ok(sys, "a system message reaches the upstream");
    return typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content);
}


test("effort-pin unit: first request pins, a switch is restored, model change re-pins", () => {
    const meta: Record<string, unknown> = {};
    const b1: Record<string, unknown> = { model: "claude-x", thinking: { type: "enabled", budget_tokens: 1024 } };
    assert.equal(applyEffortPin(b1, meta), "pinned");
    const b2: Record<string, unknown> = { model: "claude-x", thinking: { type: "enabled", budget_tokens: 1024 } };
    assert.equal(applyEffortPin(b2, meta), "kept");
    const b3: Record<string, unknown> = { model: "claude-x", thinking: { type: "enabled", budget_tokens: 32000 }, output_config: { effort: "high", format: "x" } };
    assert.equal(applyEffortPin(b3, meta), "restored");
    assert.deepEqual(b3.thinking, { type: "enabled", budget_tokens: 1024 });
    assert.deepEqual(b3.output_config, { format: "x" }, "effort removed, sibling keys kept");
    const b4: Record<string, unknown> = { model: "claude-x", thinking: { type: "disabled" } };
    assert.equal(applyEffortPin(b4, meta), "restored");
    assert.deepEqual(b4.thinking, { type: "enabled", budget_tokens: 1024 });
    const b5: Record<string, unknown> = { model: "claude-y", output_config: { effort: "max" } };
    assert.equal(applyEffortPin(b5, meta), "repinned");
    const b6: Record<string, unknown> = { model: "claude-y", thinking: { type: "adaptive" } };
    assert.equal(applyEffortPin(b6, meta), "restored");
    assert.equal(b6.thinking, undefined, "pinned absence is restored as absence");
    assert.deepEqual(b6.output_config, { effort: "max" });
});

function anthropicUpstream(seen: Array<Record<string, unknown>>): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            try { seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { seen.push({}); }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_t", type: "message", role: "assistant", model: "claude-x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function twoTurns(pin: boolean): Promise<Array<Record<string, unknown>>> {
    const seen: Array<Record<string, unknown>> = [];
    const upstream = await anthropicUpstream(seen);
    const harness = await startProxy(upstream, (u) => ({ providers: pin ? { [u]: { pinEffort: true } } : {} }));
    const sid = `effort-pin-${pin}-${Date.now()}`;
    const send = (budget: number, msgs: unknown[]) => fetch(`http://127.0.0.1:${harness.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": sid, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-x", max_tokens: 64000, thinking: { type: "enabled", budget_tokens: budget }, messages: msgs }),
    });
    try {
        assert.equal((await send(1024, [{ role: "user", content: "hello" }])).status, 200);
        assert.equal((await send(32000, [{ role: "user", content: "hello" }, { role: "assistant", content: "ok" }, { role: "user", content: "again" }])).status, 200);
        return seen;
    } finally {
        await harness.stop();
        harness.cleanup();
        await close(upstream);
    }
}

test("effort-pin e2e: pinned route forwards the first request's thinking on later turns", async () => {
    const seen = await twoTurns(true);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1]!.thinking, { type: "enabled", budget_tokens: 1024 });
});

test("effort-pin e2e: routes without pinEffort forward the client's thinking unchanged", async () => {
    const seen = await twoTurns(false);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1]!.thinking, { type: "enabled", budget_tokens: 32000 });
});
