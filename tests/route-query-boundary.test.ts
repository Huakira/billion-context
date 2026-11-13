import test from "node:test";
import assert from "node:assert/strict";
import { findRouteKey, findRoute } from "../src/config.ts";

const origin = "https://axon.example";
const endpoint = `${origin}/v1/messages`;

test("endpoint route applies to native beta query and fragment suffixes", () => {
    const routes = { [origin]: {}, [`${origin}/v1`]: {}, [endpoint]: { renderNone: true, pinEffort: true } };
    for (const suffix of ["", "?beta=true", "#fragment", "?beta=true#fragment", "/", "/count_tokens?beta=true"]) {
        assert.equal(findRouteKey(routes, endpoint + suffix), endpoint, suffix);
        assert.equal(findRoute(routes, endpoint + suffix)?.renderNone, true, suffix);
        assert.equal(findRoute(routes, endpoint + suffix)?.pinEffort, true, suffix);
    }
});

test("query matching retains segment and host boundaries", () => {
    const routes = { [origin]: {}, [endpoint]: { renderNone: true } };
    assert.equal(findRouteKey(routes, `${endpoint}-other?beta=true`), origin);
    assert.equal(findRouteKey(routes, `${origin}.evil/v1/messages?beta=true`), undefined);
    assert.equal(findRouteKey(routes, `https://unrelated.example/v1/messages?dest=${endpoint}`), undefined);
    assert.equal(findRouteKey(routes, undefined), undefined);
});

test("explicit query keys keep existing literal semantics and longest match", () => {
    const queryKey = `${endpoint}?beta=true`;
    const routes = { [origin]: {}, [endpoint]: {}, [queryKey]: { renderNone: false } };
    assert.equal(findRouteKey(routes, queryKey), queryKey);
    assert.equal(findRouteKey(routes, `${queryKey}/child`), queryKey);
    assert.equal(findRouteKey(routes, `${queryKey}&other=1`), endpoint);
    assert.equal(findRouteKey(routes, `${queryKey}#fragment`), endpoint);
    assert.equal(findRouteKey(routes, `${endpoint}?beta=false`), endpoint);
});
