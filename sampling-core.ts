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
}

export interface SamplingConfig {
	profiles?: Record<string, SamplingProfile>;
	models?: Record<string, SamplingParams>;
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
		result.profiles = { ...result.profiles, ...project.profiles };
	}

	if (global?.models) {
		result.models = { ...global.models };
	}
	if (project?.models) {
		result.models = { ...result.models, ...project.models };
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

// ============================================================================
// Sampling Parameter Resolution
// ============================================================================

export function getActiveParams(
	modelId: string,
	config: SamplingConfig,
	activeProfileName: string | undefined,
): SamplingParams {
	const result: SamplingParams = {};

	if (activeProfileName && config.profiles?.[activeProfileName]) {
		Object.assign(result, config.profiles[activeProfileName]);
	} else if (config.profiles?.default) {
		Object.assign(result, config.profiles.default);
	}

	const modelOverrides = findMatchingParams(modelId, config.models);
	if (modelOverrides) {
		Object.assign(result, modelOverrides);
	}

	return result;
}

export function hasAnySamplingParams(params: SamplingParams): boolean {
	return SAMPLING_PARAMS_KEYS.some((key) => params[key] !== undefined);
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
