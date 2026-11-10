import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildModels } from "./models.js";

/**
 * Read Pi's current Anthropic catalog, including the cached remote catalog that
 * `getModels("anthropic")` from pi-ai's compat entrypoint cannot see.
 *
 * Pi restores `models-store.json` during an offline `ModelRuntime` refresh. That
 * snapshot is what carries newer catalog entries, such as a model released
 * after the pinned pi-ai build. `allowModelNetwork: false` keeps this read
 * cache-only: the host owns catalog fetching and persistence, and a dynamic
 * provider must not issue a second network refresh.
 *
 * Returns undefined when the runtime cannot be built or exposes no Anthropic
 * models, so the caller can fall back to its bundled catalog.
 */
export async function loadPiAnthropicModels(signal?: AbortSignal) {
	const runtime = await ModelRuntime.create({
		allowModelNetwork: false,
		refreshOnCreate: true,
		...(signal ? { signal } : {}),
	});
	const models = runtime.getModels("anthropic");
	return models.length > 0 ? buildModels([...models]) : undefined;
}
