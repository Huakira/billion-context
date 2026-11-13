/**
 * Fork-only (Huakira/billion-context): route-scoped reasoning-effort pin.
 *
 * Stateful Claude Code relays (magpie) key a live session on the request's
 * settings. A mid-conversation effort switch (thinking budget / adaptive
 * effort) makes the relay start a fresh Claude Code run and replay the whole
 * transcript, so the first request after the switch pays the full history.
 * With `providers[<url>].pinEffort: true`, the first Anthropic request of a
 * session records its `thinking` and `output_config.effort`; later requests of
 * the same session and model are rewritten back to those values. A model
 * switch re-pins (the switch already costs a fresh run).
 */

export interface EffortPin {
    model: string | null;
    thinking: unknown;
    effort: string | null;
}

const META_KEY = "effortPin";

function effortOf(body: Record<string, unknown>): string | null {
    const oc = body.output_config;
    if (oc && typeof oc === "object" && !Array.isArray(oc)) {
        const e = (oc as Record<string, unknown>).effort;
        if (typeof e === "string") return e;
    }
    return null;
}

function snapshot(body: Record<string, unknown>): EffortPin {
    return {
        model: typeof body.model === "string" ? body.model : null,
        thinking: body.thinking === undefined ? null : JSON.parse(JSON.stringify(body.thinking)),
        effort: effortOf(body),
    };
}

function same(a: EffortPin, b: EffortPin): boolean {
    return JSON.stringify(a.thinking) === JSON.stringify(b.thinking) && a.effort === b.effort;
}

/** Pin or restore effort on an Anthropic request body, in place. Returns what happened. */
export function applyEffortPin(body: Record<string, unknown>, metadata: Record<string, unknown>): "pinned" | "kept" | "restored" | "repinned" {
    const now = snapshot(body);
    const prev = metadata[META_KEY] as EffortPin | undefined;
    if (!prev || typeof prev !== "object") { metadata[META_KEY] = now; return "pinned"; }
    if (prev.model !== now.model) { metadata[META_KEY] = now; return "repinned"; }
    if (same(prev, now)) return "kept";
    if (prev.thinking === null) delete body.thinking;
    else body.thinking = JSON.parse(JSON.stringify(prev.thinking));
    const oc = body.output_config && typeof body.output_config === "object" && !Array.isArray(body.output_config)
        ? { ...(body.output_config as Record<string, unknown>) } : {};
    if (prev.effort === null) delete oc.effort; else oc.effort = prev.effort;
    if (Object.keys(oc).length > 0) body.output_config = oc; else delete body.output_config;
    return "restored";
}
