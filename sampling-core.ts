/**
 * Control Your Sampling - Pure logic (no pi dependencies)
 * Extracted for unit testing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Config Types
// ============================================================================

export interface SamplingParams {
	temperature?: number;
	top_p?: number;
	top_k?: number;
	min_p?: number;
	frequency_penalty?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	seed?: number;
}

export interface SamplingProfile extends SamplingParams {
	// Profile name comes from the JSON key
	/**
	 * Model patterns for which this profile's sampling parameters should
	 * not be injected. Does not affect other profiles.
	 */
	skipSampling?: string[];
}

export interface SamplingModelConfig extends SamplingParams {
	/**
	 * If true, suppress all sampling parameter injection for matching models.
	 */
	skipSampling?: boolean;
}

export interface SamplingConfig {
	profiles?: Record<string, SamplingProfile>;
	models?: Record<string, SamplingModelConfig>;
	/**
	 * Global model patterns for which sampling parameters should not be injected.
	 */
	skipSampling?: string[];
	/**
	 * Provider patterns for which sampling parameters should not be injected.
	 * Examples: "openai", "openai-codex", "github-copilot".
	 */
	skipSamplingProviders?: string[];
	/**
	 * Provider patterns that opt out of the built-in official OpenAI skip.
	 * This only disables the built-in default; explicit skipSampling* rules still apply.
	 */
	allowSamplingProviders?: string[];
	/**
	 * API types for which sampling parameters should not be injected.
	 * Examples: "openai-completions", "openai-responses", "openai-codex-responses".
	 */
	skipSamplingApis?: string[];
	/**
	 * Agent-specific profile overrides.
	 * Maps agent type (from pi-subagents <active_agent> tag) to
	 * model-pattern → profile-name mappings.
	 *
	 * Example:
	 * {
	 *   "Explore": {
	 *     "accounts/fireworks/models/kimi-k2p6": "kimi-precise",
	 *     "*": "explore-default"
	 *   },
	 *   "general-purpose": {
	 *     "accounts/fireworks/models/kimi-k2p6": "default"
	 *   }
	 * }
	 */
	agentProfiles?: Record<string, Record<string, string>>;
}

// ============================================================================
// Constants
// ============================================================================

export const SAMPLING_PARAMS_KEYS: (keyof SamplingParams)[] = [
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"frequency_penalty",
	"presence_penalty",
	"repetition_penalty",
	"seed",
];

export const OPENAI_STYLE_APIS: string[] = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
];

/**
 * Official OpenAI-hosted providers reject most sampling controls for current
 * GPT/Codex models. Keep OpenAI-compatible local/custom providers enabled by
 * default by matching provider names, not API transport names.
 */
export const DEFAULT_SKIP_SAMPLING_PROVIDERS: string[] = [
	"openai",
	"openai-codex",
	"azure-openai-responses",
	"github-copilot",
];

// ============================================================================
// Config Loading
// ============================================================================

export function getConfigPath(cwd: string): { global: string; project: string } {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return {
		global: join(agentDir, "sampling.json"),
		project: join(cwd, ".pi", "sampling.json"),
	};
}

export function loadConfigFile(path: string): SamplingConfig | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as SamplingConfig;
	} catch (err) {
		console.error(`[sampling] Failed to load config from ${path}:`, err);
		return undefined;
	}
}

export function mergeConfig(global: SamplingConfig | undefined, project: SamplingConfig | undefined): SamplingConfig {
	const result: SamplingConfig = {};

	if (global?.profiles) {
		result.profiles = { ...global.profiles };
	}
	if (project?.profiles) {
		result.profiles = result.profiles ?? {};
		for (const [name, projectProfile] of Object.entries(project.profiles)) {
			const globalProfile = result.profiles[name] ?? {};
			result.profiles[name] = { ...globalProfile, ...projectProfile };
		}
	}

	if (global?.models) {
		result.models = { ...global.models };
	}
	if (project?.models) {
		result.models = result.models ?? {};
		for (const [pattern, projectModel] of Object.entries(project.models)) {
			const globalModel = result.models[pattern] ?? {};
			result.models[pattern] = { ...globalModel, ...projectModel };
		}
	}

	if (global?.skipSampling) {
		result.skipSampling = [...global.skipSampling];
	}
	if (project?.skipSampling) {
		result.skipSampling = [...(result.skipSampling ?? []), ...project.skipSampling];
	}

	if (global?.skipSamplingProviders) {
		result.skipSamplingProviders = [...global.skipSamplingProviders];
	}
	if (project?.skipSamplingProviders) {
		result.skipSamplingProviders = [...(result.skipSamplingProviders ?? []), ...project.skipSamplingProviders];
	}

	if (global?.allowSamplingProviders) {
		result.allowSamplingProviders = [...global.allowSamplingProviders];
	}
	if (project?.allowSamplingProviders) {
		result.allowSamplingProviders = [...(result.allowSamplingProviders ?? []), ...project.allowSamplingProviders];
	}

	if (global?.skipSamplingApis) {
		result.skipSamplingApis = [...global.skipSamplingApis];
	}
	if (project?.skipSamplingApis) {
		result.skipSamplingApis = [...(result.skipSamplingApis ?? []), ...project.skipSamplingApis];
	}

	if (global?.agentProfiles) {
		result.agentProfiles = { ...global.agentProfiles };
	}
	if (project?.agentProfiles) {
		result.agentProfiles = result.agentProfiles ?? {};
		for (const [agentType, projectMapping] of Object.entries(project.agentProfiles)) {
			const globalMapping = result.agentProfiles[agentType] ?? {};
			result.agentProfiles[agentType] = { ...globalMapping, ...projectMapping };
		}
	}

	return result;
}

export function loadConfig(cwd: string): SamplingConfig {
	const paths = getConfigPath(cwd);
	const global = loadConfigFile(paths.global);
	const project = loadConfigFile(paths.project);
	return mergeConfig(global, project);
}

// ============================================================================
// Pattern Matching
// ============================================================================

export function matchPattern(pattern: string, value: string): boolean {
	// For model IDs (provider/model-id), * matches any characters including /
	// because model IDs are not filesystem paths. ** also works for deep matching.
	const regexPattern = pattern
		.replace(/\*\*/g, "<<<DOUBLESTAR>>>")
		.replace(/\*/g, ".*")
		.replace(/<<<DOUBLESTAR>>>/g, ".*")
		.replace(/\?/g, ".");

	try {
		const regex = new RegExp(`^${regexPattern}$`);
		return regex.test(value);
	} catch {
		return pattern === value;
	}
}

export function findMatchingParams(modelId: string, modelConfig: Record<string, SamplingParams> | undefined): SamplingParams | undefined {
	if (!modelConfig) return undefined;

	for (const [pattern, params] of Object.entries(modelConfig)) {
		if (matchPattern(pattern, modelId)) {
			return params;
		}
	}
	return undefined;
}

export function findMatchingValue<T>(modelId: string, mapping: Record<string, T> | undefined): T | undefined {
	if (!mapping) return undefined;
	for (const [pattern, value] of Object.entries(mapping)) {
		if (matchPattern(pattern, modelId)) {
			return value;
		}
	}
	return undefined;
}

// ============================================================================
// Sampling Parameter Resolution
// ============================================================================

/**
 * Parse the <active_agent name="..."/> tag from a system prompt string.
 * Returns the agent type name, or undefined if no tag is found (main agent).
 */
export function parseActiveAgentTag(systemPrompt: string): string | undefined {
	const match = systemPrompt.match(/<active_agent\s+name="([^"]+)"\s*\/?>\s?/);
	return match ? match[1] : undefined;
}

/**
 * Resolve the effective profile name for a given model, considering
 * agent-specific profile overrides.
 */
export function resolveEffectiveProfile(
	modelId: string,
	config: SamplingConfig,
	activeProfileName: string | undefined,
	agentType: string | undefined,
): string | undefined {
	// Check agent-specific profile override first
	if (agentType && config.agentProfiles?.[agentType]) {
		const modelMapping = config.agentProfiles[agentType];
		const overrideProfile = findMatchingValue(modelId, modelMapping);
		if (overrideProfile) {
			return overrideProfile;
		}
	}
	return activeProfileName;
}

export function getActiveParams(
	modelId: string,
	config: SamplingConfig,
	activeProfileName: string | undefined,
	agentType?: string | undefined,
): SamplingParams {
	const result: SamplingParams = {};

	// Resolve which profile to use (agent-specific overrides take precedence)
	const effectiveProfile = resolveEffectiveProfile(modelId, config, activeProfileName, agentType);

	const copyParams = (source: SamplingParams) => {
		for (const key of SAMPLING_PARAMS_KEYS) {
			if (source[key] !== undefined) {
				result[key] = source[key];
			}
		}
	};

	if (effectiveProfile && config.profiles?.[effectiveProfile]) {
		copyParams(config.profiles[effectiveProfile]);
	} else if (config.profiles?.default) {
		copyParams(config.profiles.default);
	}

	const modelOverrides = findMatchingParams(modelId, config.models);
	if (modelOverrides) {
		copyParams(modelOverrides);
	}

	return result;
}

export function hasAnySamplingParams(params: SamplingParams): boolean {
	return SAMPLING_PARAMS_KEYS.some((key) => params[key] !== undefined);
}

// ============================================================================
// Skip Sampling Logic
// ============================================================================

export function matchAnyPattern(value: string, patterns: string[] | undefined): boolean {
	if (!patterns) return false;
	for (const pattern of patterns) {
		if (matchPattern(pattern, value)) {
			return true;
		}
	}
	return false;
}

export function shouldSkipSampling(
	modelId: string,
	config: SamplingConfig,
	activeProfileName: string | undefined,
	agentType?: string | undefined,
	api?: string | undefined,
	provider?: string | undefined,
): { skip: boolean; reason?: string } {
	if (matchAnyPattern(modelId, config.skipSampling)) {
		return { skip: true, reason: "global skipSampling" };
	}

	const resolvedProvider = provider ?? modelId.split("/")[0];
	if (resolvedProvider && matchAnyPattern(resolvedProvider, config.skipSamplingProviders)) {
		return { skip: true, reason: `provider ${resolvedProvider}` };
	}

	if (api && matchAnyPattern(api, config.skipSamplingApis)) {
		return { skip: true, reason: `api ${api}` };
	}

	const allowBuiltInProviderSkip = !matchAnyPattern(resolvedProvider, config.allowSamplingProviders);
	if (allowBuiltInProviderSkip && matchAnyPattern(resolvedProvider, DEFAULT_SKIP_SAMPLING_PROVIDERS)) {
		return { skip: true, reason: `official OpenAI provider ${resolvedProvider}` };
	}

	const effectiveProfile = resolveEffectiveProfile(modelId, config, activeProfileName, agentType);
	const profile = effectiveProfile && config.profiles?.[effectiveProfile]
		? config.profiles[effectiveProfile]
		: config.profiles?.default;
	const profileName = effectiveProfile && config.profiles?.[effectiveProfile]
		? effectiveProfile
		: "default";

	if (matchAnyPattern(modelId, profile?.skipSampling)) {
		return { skip: true, reason: `profile "${profileName}" skipSampling` };
	}

	const modelEntry = findMatchingParams(modelId, config.models);
	if (modelEntry && (modelEntry as SamplingModelConfig).skipSampling === true) {
		return { skip: true, reason: "model override skipSampling" };
	}

	return { skip: false };
}

// ============================================================================
// API Type Checking
// ============================================================================

export function isOpenAiStyleApi(api: string | undefined): boolean {
	return api !== undefined && OPENAI_STYLE_APIS.includes(api);
}

// ============================================================================
// Payload Injection
// ============================================================================

export function isOpenAiStylePayload(payload: unknown): payload is Record<string, unknown> {
	// Relaxed check: any object with a model field is likely an OpenAI-style request.
	// The isOpenAiStyleApi() check already filters by API type.
	return typeof payload === "object" && payload !== null && "model" in payload;
}

export function injectSamplingParams(payload: unknown, params: SamplingParams): unknown {
	if (!isOpenAiStylePayload(payload)) {
		return payload;
	}

	const result = { ...payload };
	for (const key of SAMPLING_PARAMS_KEYS) {
		if (params[key] !== undefined) {
			result[key] = params[key];
		}
	}
	return result;
}

// ============================================================================
// UI Helpers
// ============================================================================

export function formatSamplingStatus(params: SamplingParams): string {
	const parts: string[] = [];
	if (params.temperature !== undefined) parts.push(`t=${params.temperature}`);
	if (params.top_p !== undefined) parts.push(`p=${params.top_p}`);
	if (params.top_k !== undefined) parts.push(`k=${params.top_k}`);
	if (params.min_p !== undefined) parts.push(`mp=${params.min_p}`);
	if (parts.length === 0) return "";
	return parts.join(" ");
}

export function getProfileNames(config: SamplingConfig): string[] {
	if (!config.profiles) return [];
	return Object.keys(config.profiles).sort();
}
