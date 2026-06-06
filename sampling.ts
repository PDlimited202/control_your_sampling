/**
 * Control Your Sampling - Pi Extension
 *
 * Per-model, per-profile, per-agent-type sampling parameter control for OpenAI-compatible API endpoints.
 * Supports llama.cpp, vLLM, SGLang, LM Studio, OpenRouter, and other OpenAI-compatible backends.
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	loadConfig,
	getActiveParams,
	resolveEffectiveProfile,
	hasAnySamplingParams,
	isOpenAiStyleApi,
	injectSamplingParams,
	formatSamplingStatus,
	getProfileNames,
	parseActiveAgentTag,
	OPENAI_STYLE_APIS,
	SAMPLING_PARAMS_KEYS,
	type SamplingConfig,
	type SamplingParams,
} from "./sampling-core";

// ============================================================================
// Global State
// ============================================================================

let config: SamplingConfig = {};
let activeProfileName: string | undefined;
let currentAgentType: string | undefined;

const DEBUG = process.env.PI_SAMPLING_DEBUG === "1";

// ============================================================================
// Logging
// ============================================================================

function getLogPath(cwd: string): string {
	return join(cwd, ".pi", "sampling-debug.log");
}

function logDebug(cwd: string, message: string, payload?: unknown) {
	const logPath = getLogPath(cwd);
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		const timestamp = new Date().toISOString();
		const line = `[${timestamp}] ${message}\n${payload ? JSON.stringify(payload, null, 2) + "\n" : ""}`;
		appendFileSync(logPath, line, "utf-8");
	} catch {
		// Silently ignore debug log errors
	}
}

function logAlways(cwd: string, message: string) {
	const logPath = getLogPath(cwd);
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		const timestamp = new Date().toISOString();
		appendFileSync(logPath, `[${timestamp}] ${message}\n`, "utf-8");
	} catch {
		// Silently ignore log errors
	}
}

// ============================================================================
// UI Helpers
// ============================================================================

function updateStatus(ctx: ExtensionContext, modelId: string) {
	const effectiveProfile = resolveEffectiveProfile(modelId, config, activeProfileName, currentAgentType);
	const params = getActiveParams(modelId, config, activeProfileName, currentAgentType);
	const status = formatSamplingStatus(params);
	const agentLabel = currentAgentType ? `[${currentAgentType}] ` : "";
	if (status) {
		ctx.ui.setStatus("sampling", `${agentLabel}sampling:${effectiveProfile ?? activeProfileName ?? "default"} ${status}`);
	} else {
		ctx.ui.setStatus("sampling", undefined);
	}
}

// ============================================================================
// Profile Switching
// ============================================================================

function setProfile(name: string, ctx: ExtensionContext): boolean {
	if (name !== "default" && !config.profiles?.[name]) {
		return false;
	}
	activeProfileName = name;
	if (ctx.model) {
		updateStatus(ctx, `${ctx.model.provider}/${ctx.model.id}`);
	} else {
		ctx.ui.setStatus("sampling", `sampling:${name}`);
	}
	return true;
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function samplingExtension(pi: ExtensionAPI) {
	// Register CLI flag
	pi.registerFlag("sampling-profile", {
		description: "Active sampling profile",
		type: "string",
	});

	// Detect agent type from system prompt before each agent turn
	pi.on("before_agent_start", async (event, ctx) => {
		const tag = parseActiveAgentTag(event.systemPrompt);
		if (tag !== currentAgentType) {
			currentAgentType = tag;
			logAlways(ctx.cwd, `[before_agent_start] Detected agent type: ${tag ?? "main"}`);
			if (ctx.model) {
				updateStatus(ctx, `${ctx.model.provider}/${ctx.model.id}`);
			}
		}
	});

	// Handle model changes to update status
	pi.on("model_select", async (event, ctx) => {
		const modelId = `${event.model.provider}/${event.model.id}`;
		updateStatus(ctx, modelId);
	});

	// Intercept provider requests and inject sampling parameters
	pi.on("before_provider_request", async (event, ctx) => {
		if (!ctx.model) {
			logAlways(ctx.cwd, "[before_provider_request] No model in context, skipping");
			return;
		}

		const api = ctx.model.api;
		const modelId = `${ctx.model.provider}/${ctx.model.id}`;

		logAlways(ctx.cwd, `[before_provider_request] Model: ${modelId}, API: ${api ?? "undefined"}, OpenAI-style: ${isOpenAiStyleApi(api)}`);

		if (!isOpenAiStyleApi(api)) {
			logAlways(ctx.cwd, `[before_provider_request] Skipping non-OpenAI API: ${api}`);
			return;
		}

		const effectiveProfile = resolveEffectiveProfile(modelId, config, activeProfileName, currentAgentType);
		const params = getActiveParams(modelId, config, activeProfileName, currentAgentType);
		logAlways(ctx.cwd, `[before_provider_request] Resolved params: ${JSON.stringify(params)} (agent: ${currentAgentType ?? "main"}, effectiveProfile: ${effectiveProfile ?? activeProfileName ?? "default"})`);

		if (!hasAnySamplingParams(params)) {
			logAlways(ctx.cwd, `[before_provider_request] No sampling params for ${modelId}, passing through`);
			return;
		}

		logDebug(ctx.cwd, `[before_provider_request] Before injection for ${modelId} (agent: ${currentAgentType ?? "main"}, profile: ${effectiveProfile ?? activeProfileName ?? "default"})`, event.payload);
		const modified = injectSamplingParams(event.payload, params);
		logDebug(ctx.cwd, `[before_provider_request] After injection for ${modelId}`, modified);

		const injectedKeys = SAMPLING_PARAMS_KEYS.filter((k) => params[k] !== undefined);
		logAlways(ctx.cwd, `[before_provider_request] Injected keys for ${modelId}: ${injectedKeys.join(", ")}`);

		return modified;
	});

	// Log after response to confirm request went through
	pi.on("after_provider_response", async (event, ctx) => {
		logAlways(ctx.cwd, `[after_provider_response] Status: ${event.status}`);
		if (event.status >= 400) {
			logAlways(ctx.cwd, `[after_provider_response] ERROR response: ${event.status}`);
		}
	});

	// Register /sampling command
	pi.registerCommand("sampling", {
		description: "Show or switch sampling profile",
		handler: async (args, ctx) => {
			const arg = args?.trim();

			if (!arg) {
				const profiles = getProfileNames(config);
				const current = activeProfileName ?? "default";
				let modelId = "(no model)";
				let params: SamplingParams = {};
				let effectiveProfile: string | undefined;

				if (ctx.model) {
					modelId = `${ctx.model.provider}/${ctx.model.id}`;
					params = getActiveParams(modelId, config, activeProfileName, currentAgentType);
					effectiveProfile = resolveEffectiveProfile(modelId, config, activeProfileName, currentAgentType);
				}

				let msg = `Profile: ${current}\n`;
				if (currentAgentType) {
					msg += `Agent: ${currentAgentType}\n`;
					if (effectiveProfile && effectiveProfile !== current) {
						msg += `Effective profile: ${effectiveProfile}\n`;
					}
				}
				if (profiles.length > 0) {
					msg += `Available: ${profiles.join(", ")}\n`;
				}
				msg += `Model: ${modelId}\n`;
				if (hasAnySamplingParams(params)) {
					msg += `Active params: ${JSON.stringify(params, null, 2)}`;
				} else {
					msg += "No sampling params configured.";
				}

				ctx.ui.notify(msg, "info");
				return;
			}

			// Reload config on demand
			if (arg === "reload" || arg === "load-config") {
				config = loadConfig(ctx.cwd);
				const profiles = Object.keys(config.profiles ?? {});
				const models = Object.keys(config.models ?? {});
				const agentProfiles = Object.keys(config.agentProfiles ?? {});
				let msg = "Config reloaded.\n";
				msg += `Profiles: ${profiles.join(", ") || "none"}\n`;
				msg += `Models: ${models.join(", ") || "none"}\n`;
				msg += `Agent profiles: ${agentProfiles.join(", ") || "none"}`;
				ctx.ui.notify(msg, "info");
				logAlways(ctx.cwd, `[reload] Config reloaded manually. Profiles: ${profiles.join(", ") || "none"}. Models: ${models.join(", ") || "none"}. Agent profiles: ${agentProfiles.join(", ") || "none"}`);
				if (ctx.model) {
					updateStatus(ctx, `${ctx.model.provider}/${ctx.model.id}`);
				}
				return;
			}

			if (setProfile(arg, ctx)) {
				ctx.ui.notify(`Sampling profile: ${arg}`, "info");
			} else {
				const profiles = getProfileNames(config);
				ctx.ui.notify(
					`Unknown profile "${arg}". Available: ${profiles.join(", ") || "(none defined)"}`,
					"error",
				);
			}
		},
	});

	// Initialize on session start
	pi.on("session_start", async (event, ctx) => {
		config = loadConfig(ctx.cwd);
		logAlways(ctx.cwd, `[session_start] Config loaded. Profiles: ${Object.keys(config.profiles ?? {}).join(", ") || "none"}. Models: ${Object.keys(config.models ?? {}).join(", ") || "none"}. Agent profiles: ${Object.keys(config.agentProfiles ?? {}).join(", ") || "none"}. Reason: ${event.reason}`);

		// Check CLI flag first
		const flag = pi.getFlag("sampling-profile");
		if (typeof flag === "string" && flag) {
			if (config.profiles?.[flag]) {
				activeProfileName = flag;
				logAlways(ctx.cwd, `[session_start] Set profile from CLI flag: ${flag}`);
			} else if (flag !== "default") {
				console.error(`[sampling] Unknown profile from --sampling-profile flag: ${flag}`);
			}
		}

		// Check environment variable
		if (!activeProfileName) {
			const envProfile = process.env.PI_SAMPLING_PROFILE;
			if (envProfile && config.profiles?.[envProfile]) {
				activeProfileName = envProfile;
				logAlways(ctx.cwd, `[session_start] Set profile from env: ${envProfile}`);
			}
		}

		// Default to "default" if it exists
		if (!activeProfileName && config.profiles?.default) {
			activeProfileName = "default";
			logAlways(ctx.cwd, `[session_start] Defaulted to "default" profile`);
		}

		// Reset agent type detection on new session
		currentAgentType = undefined;
		logAlways(ctx.cwd, `[session_start] Reset agent type cache`);

		if (ctx.model) {
			updateStatus(ctx, `${ctx.model.provider}/${ctx.model.id}`);
		} else if (activeProfileName) {
			ctx.ui.setStatus("sampling", `sampling:${activeProfileName}`);
		}
	});
}
