#!/usr/bin/env node

/**
 * Provider registration across module instances (issue #91's foreground failure).
 *
 * The first bridge instance registers the claude-bridge provider at activation.
 * A later instance — a subagent session that loaded this module fresh — must
 * decide at session_start based on who owns its session's model registry:
 * hosts that pass the parent's registry down already have the provider
 * (re-registering would overwrite the parent's pinned stream fn), while hosts
 * that give the child its own registry need it registered or every
 * claude-bridge/* dispatch fails with "Model not found".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "claude-bridge";

const { default: activate } = await import("../src/index.js");

function activateWithMockPi(activateFn, options = {}) {
	// pi appends handlers (a later bridge instance registers two session_start
	// handlers: clearSession + deferred registration), so the mock does too.
	const handlers = new Map();
	const registered = [];
	(activateFn ?? activate)({
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider: (name, config) => {
			registered.push({ name, config });
			options.onRegister?.(name, config);
		},
	});
	const emit = async (event, ...args) => {
		for (const handler of handlers.get(event) ?? []) await handler(...args);
	};
	return { handlers, registered, emit };
}

const sessionCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "test-session" } };

function registryWith(provider) {
	return { getProvider: (id) => (id === provider ? { name: provider } : undefined) };
}

const cachedModel = {
	id: "claude-fable-5-2",
	name: "Claude Fable 5.2",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 1000000,
	maxTokens: 128000,
};

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

// Mock only the runtime boundary; exercise the real catalog loader, projection
// and extension event handler. No credentials or model requests are involved.
function deferredCatalog(t) {
	const started = deferred();
	const ready = deferred();
	const create = t.mock.method(ModelRuntime, "create", (options) => {
		started.resolve(options);
		return ready.promise;
	});
	return {
		started: started.promise,
		create,
		resolve(models = [cachedModel]) {
			ready.resolve({ getModels: (provider) => {
				assert.equal(provider, "anthropic");
				return models;
			} });
		},
	};
}

async function awaitCatalogStart(catalog, startup) {
	return Promise.race([
		catalog.started,
		startup.then(() => { throw new Error("session_start ended before loading the current catalog"); }),
	]);
}

describe("provider registration across module instances", () => {
	it("first instance registers at activation", () => {
		const { registered } = activateWithMockPi();
		assert.equal(registered.length, 1, "exactly one activation-time registration");
		assert.equal(registered[0].name, PROVIDER_ID);
	});

	it("later instance registers at session_start when its registry lacks the provider (#91)", async () => {
		// A fresh module instance: the activate-time registration is skipped, and
		// the decision moves to session_start with the session's own registry.
		const { default: activateFresh } = await import("../src/index.js?own-registry-child");
		const { registered, emit } = activateWithMockPi(activateFresh);
		assert.equal(registered.length, 0, "no activation-time registration for a later instance");

		await emit("session_start", {}, { ...sessionCtx, modelRegistry: registryWith("other-provider") });
		assert.equal(registered.length, 1, "session_start registers into the empty registry");
		assert.equal(registered[0].name, PROVIDER_ID);
		assert.ok(registered[0].config.streamSimple, "the registration carries this instance's stream fn");
	});

	it("later instance does not re-register when the registry already has the provider", async (t) => {
		const create = t.mock.method(ModelRuntime, "create", () => {
			throw new Error("a shared registry must not need catalog discovery");
		});
		const { default: activateFresh } = await import("../src/index.js?shared-registry-child");
		const { registered, emit } = activateWithMockPi(activateFresh);

		// Host passed the parent's registry down: the provider is already there.
		await emit("session_start", {}, { ...sessionCtx, modelRegistry: registryWith(PROVIDER_ID) });
		assert.equal(registered.length, 0, "no overwrite of the parent's registration");

		// Repeated session starts stay idempotent.
		await emit("session_start", {}, { ...sessionCtx, modelRegistry: registryWith(PROVIDER_ID) });
		assert.equal(registered.length, 0, "still no registration on a later session_start");
		assert.equal(create.mock.callCount(), 0);
	});

	it("waits for the current catalog before publishing models at session_start", async (t) => {
		const catalog = deferredCatalog(t);
		const { default: activateFresh } = await import("../src/index.js?current-catalog-child");
		const { registered, emit } = activateWithMockPi(activateFresh);
		const signal = new AbortController().signal;
		const startup = emit("session_start", {}, { ...sessionCtx, signal, modelRegistry: registryWith("other-provider") });
		const options = await awaitCatalogStart(catalog, startup);
		assert.equal(options.allowModelNetwork, false, "catalog discovery stays cache-only");
		assert.equal(options.refreshOnCreate, true, "restore Pi's cached catalog");
		assert.equal(options.signal, signal, "forward the host's cancellation signal");
		assert.equal(registered.length, 0, "do not expose the bundled list while discovery is pending");

		catalog.resolve();
		await startup;
		assert.equal(registered.length, 1);
		// A host remembering the list immediately after session_start gets the
		// new model, without waiting for a second background provider refresh.
		const remembered = registered[0].config.models;
		assert.deepEqual(remembered.map((m) => m.id), [cachedModel.id]);
		assert.equal(remembered[0].contextWindow, 1000000);
		assert.equal(remembered[0].maxTokens, 128000);

		const refreshSignal = new AbortController().signal;
		const refreshed = await registered[0].config.refreshModels({ signal: refreshSignal });
		assert.deepEqual(refreshed, remembered, "on-demand refresh remains wired to the current catalog");
		assert.equal(catalog.create.mock.calls.at(-1).arguments[0].signal, refreshSignal);
	});

	it("does not overwrite a provider registered while catalog discovery is pending", async (t) => {
		const catalog = deferredCatalog(t);
		const { default: activateFresh } = await import("../src/index.js?catalog-registration-race");
		const { registered, emit } = activateWithMockPi(activateFresh);
		let provider;
		const registry = { getProvider: () => provider };
		const startup = emit("session_start", {}, { ...sessionCtx, modelRegistry: registry });
		await awaitCatalogStart(catalog, startup);
		const pinnedStream = () => {};
		provider = { streamSimple: pinnedStream };
		catalog.resolve();
		await startup;
		assert.equal(registered.length, 0, "re-check the registry after awaiting the catalog");
		assert.equal(registry.getProvider(PROVIDER_ID).streamSimple, pinnedStream);
	});

	it("concurrent session starts register only once into a shared empty registry", async (t) => {
		const catalog = deferredCatalog(t);
		const { default: activateFresh } = await import("../src/index.js?concurrent-catalog-child");
		let provider;
		const { registered, emit } = activateWithMockPi(activateFresh, {
			onRegister: (_name, config) => { provider = config; },
		});
		const ctx = { ...sessionCtx, modelRegistry: { getProvider: () => provider } };
		const startup = Promise.all([emit("session_start", {}, ctx), emit("session_start", {}, ctx)]);
		await awaitCatalogStart(catalog, startup);
		catalog.resolve();
		await startup;
		assert.equal(registered.length, 1, "the second initializer must not replace the first stream");
		assert.equal(provider, registered[0].config);
	});

	it("keeps the bundled fallback when cached catalog discovery fails", async (t) => {
		const create = t.mock.method(ModelRuntime, "create", async () => { throw new Error("unreadable catalog"); });
		const { default: activateFresh } = await import("../src/index.js?catalog-fallback-child");
		const { registered, emit } = activateWithMockPi(activateFresh);
		await emit("session_start", {}, { ...sessionCtx, modelRegistry: registryWith("other-provider") });
		assert.equal(registered.length, 1);
		assert.ok(registered[0].config.models.some((m) => m.id === "claude-fable-5-1"));
		assert.equal(typeof registered[0].config.streamSimple, "function");
		assert.equal(create.mock.callCount(), 1, "exercise the failed catalog load before falling back");
	});
});
