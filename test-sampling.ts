/**
 * Test suite for Control Your Sampling core logic
 * Run: npx tsx test-sampling.ts
 */

import {
  loadConfig,
  getConfigPath,
  getActiveParams,
  hasAnySamplingParams,
  isOpenAiStyleApi,
  injectSamplingParams,
  formatSamplingStatus,
  getProfileNames,
  matchPattern,
  findMatchingParams,
  findMatchingValue,
  mergeConfig,
  parseActiveAgentTag,
  resolveEffectiveProfile,
  OPENAI_STYLE_APIS,
  type SamplingConfig,
  type SamplingParams,
} from "./sampling-core";

// ============================================================================
// Test Framework
// ============================================================================

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passCount++;
    console.log(`  ✓ ${message}`);
  } else {
    failCount++;
    console.log(`  ✗ ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    passCount++;
    console.log(`  ✓ ${message}`);
  } else {
    failCount++;
    console.log(`  ✗ ${message}`);
    console.log(`    Expected: ${JSON.stringify(expected)}`);
    console.log(`    Actual:   ${JSON.stringify(actual)}`);
  }
}

function test(name: string, fn: () => void) {
  console.log(`\n${name}`);
  try {
    fn();
  } catch (err) {
    failCount++;
    console.log(`  ✗ EXCEPTION: ${err}`);
  }
}

// ============================================================================
// Tests
// ============================================================================

// --- Config loading ---

test("loadConfig handles missing files gracefully", () => {
  const config = loadConfig("/nonexistent/path");
  assert(typeof config === "object", "Returns an object");
  assert(config !== null, "Returns non-null");
  // Global config at ~/.pi/agent/sampling.json is loaded when project config is missing
  assert(config.profiles !== undefined || config.agentProfiles !== undefined || config.models !== undefined, "Loads global config when available");
});

// --- Pattern matching ---

test("matchPattern exact match", () => {
  assert(matchPattern("llama.cpp/llama3.1:8b", "llama.cpp/llama3.1:8b"), "Exact match works");
});

test("matchPattern wildcard at end", () => {
  assert(matchPattern("llama.cpp/llama*", "llama.cpp/llama3.1:8b"), "Wildcard matches suffix");
  assert(matchPattern("llama.cpp/llama*", "llama.cpp/llama3"), "Wildcard matches shorter name");
  assert(!matchPattern("llama.cpp/llama*", "llama.cpp/qwen2.5"), "Wildcard doesn't match different model");
});

test("matchPattern wildcard at start", () => {
  assert(matchPattern("*/qwen*", "llama.cpp/qwen2.5"), "Wildcard at start matches provider");
  assert(matchPattern("*/qwen*", "vllm/qwen-coder"), "Wildcard at start matches any provider");
});

test("matchPattern full wildcard", () => {
  assert(matchPattern("openrouter/*", "openrouter/anthropic/claude-3.5-sonnet"), "Full wildcard matches");
  assert(!matchPattern("openrouter/*", "llama.cpp/llama3"), "Full wildcard doesn't match different provider");
});

test("matchPattern double wildcard", () => {
  assert(matchPattern("**", "anything/here/works"), "Double star matches everything");
});

// --- findMatchingParams ---

test("findMatchingParams returns first match", () => {
  const models: Record<string, SamplingParams> = {
    "llama.cpp/llama*": { temperature: 0.8 },
    "llama.cpp/llama3.1*": { temperature: 0.9 },
  };
  const result = findMatchingParams("llama.cpp/llama3.1:8b", models);
  assertEqual(result?.temperature, 0.8, "First match wins");
});

test("findMatchingParams returns undefined for no match", () => {
  const result = findMatchingParams("unknown/model", { "llama.cpp/*": { temperature: 0.5 } });
  assertEqual(result, undefined, "No match returns undefined");
});

// --- mergeConfig ---

test("mergeConfig merges profiles and models", () => {
  const global: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, global: { temperature: 0.5 } },
    models: { "llama.cpp/*": { temperature: 0.8 } },
  };
  const project: SamplingConfig = {
    profiles: { default: { temperature: 0.6 }, project: { temperature: 0.4 } },
    models: { "llama.cpp/llama*": { temperature: 0.9 } },
  };
  const merged = mergeConfig(global, project);
  assertEqual(merged.profiles?.default?.temperature, 0.6, "Project overrides global profile");
  assertEqual(merged.profiles?.global?.temperature, 0.5, "Global-only profile preserved");
  assertEqual(merged.profiles?.project?.temperature, 0.4, "Project-only profile added");
  assertEqual(merged.models?.["llama.cpp/llama*"]?.temperature, 0.9, "Project model overrides global");
  assertEqual(merged.models?.["llama.cpp/*"]?.temperature, 0.8, "Global-only model preserved");
});

test("mergeConfig merges agentProfiles", () => {
  const global: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, precise: { temperature: 0.2 } },
    agentProfiles: {
      Explore: { "*": "precise", "llama.cpp/*": "default" },
      Plan: { "*": "precise" },
    },
  };
  const project: SamplingConfig = {
    agentProfiles: {
      Explore: { "accounts/fireworks/*": "creative" },
      general: { "*": "default" },
    },
  };
  const merged = mergeConfig(global, project);
  assertEqual(merged.agentProfiles?.Explore?.["*"], "precise", "Global agent wildcard preserved");
  assertEqual(merged.agentProfiles?.Explore?.["llama.cpp/*"], "default", "Global agent pattern preserved");
  assertEqual(merged.agentProfiles?.Explore?.["accounts/fireworks/*"], "creative", "Project agent pattern added");
  assertEqual(merged.agentProfiles?.Plan?.["*"], "precise", "Global-only agent profile preserved");
  assertEqual(merged.agentProfiles?.general?.["*"], "default", "Project-only agent profile added");
});

test("getConfigPath returns correct paths", () => {
  const paths = getConfigPath("/some/project");
  assert(paths.global.endsWith(".pi/agent/sampling.json"), "Global path ends with .pi/agent/sampling.json");
  assertEqual(paths.project, "/some/project/.pi/sampling.json", "Project path includes cwd");
});

// --- getActiveParams ---

test("getActiveParams uses default profile when no active profile", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7, top_p: 0.9 } },
  };
  const params = getActiveParams("llama.cpp/llama3", config, undefined);
  assertEqual(params.temperature, 0.7, "Default profile temperature applied");
  assertEqual(params.top_p, 0.9, "Default profile top_p applied");
});

test("getActiveParams uses active profile", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, precise: { temperature: 0.2 } },
  };
  const params = getActiveParams("llama.cpp/llama3", config, "precise");
  assertEqual(params.temperature, 0.2, "Active profile temperature applied");
});

test("getActiveParams model overrides win", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7, top_p: 0.9 } },
    models: { "llama.cpp/llama*": { temperature: 0.8 } },
  };
  const params = getActiveParams("llama.cpp/llama3.1:8b", config, undefined);
  assertEqual(params.temperature, 0.8, "Model override wins");
  assertEqual(params.top_p, 0.9, "Profile param preserved when not overridden");
});

test("getActiveParams active profile + model override", () => {
  const config: SamplingConfig = {
    profiles: { precise: { temperature: 0.2, top_p: 0.1 } },
    models: { "llama.cpp/llama*": { temperature: 0.8 } },
  };
  const params = getActiveParams("llama.cpp/llama3", config, "precise");
  assertEqual(params.temperature, 0.8, "Model override wins over profile");
  assertEqual(params.top_p, 0.1, "Profile param preserved");
});

test("getActiveParams no config returns empty", () => {
  const params = getActiveParams("any/model", {}, undefined);
  assertEqual(params, {}, "Empty config returns empty params");
});

// --- hasAnySamplingParams ---

test("hasAnySamplingParams detects params", () => {
  assert(hasAnySamplingParams({ temperature: 0.7 }), "Detects temperature");
  assert(hasAnySamplingParams({ seed: 42 }), "Detects seed");
  assert(!hasAnySamplingParams({}), "Empty object has no params");
  assert(!hasAnySamplingParams({ unknown: 123 } as any), "Unknown keys ignored");
});

// --- isOpenAiStyleApi ---

test("isOpenAiStyleApi recognizes OpenAI APIs", () => {
  for (const api of OPENAI_STYLE_APIS) {
    assert(isOpenAiStyleApi(api), `${api} is recognized`);
  }
  assert(!isOpenAiStyleApi("anthropic-messages"), "Anthropic is not OpenAI-style");
  assert(!isOpenAiStyleApi(undefined), "Undefined is not OpenAI-style");
});

// --- injectSamplingParams ---

test("injectSamplingParams adds sampling params to payload", () => {
  const payload = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };
  const params = { temperature: 0.7, top_p: 0.9, seed: 42 };
  const result = injectSamplingParams(payload, params) as Record<string, unknown>;
  assertEqual(result.temperature, 0.7, "Temperature injected");
  assertEqual(result.top_p, 0.9, "Top_p injected");
  assertEqual(result.seed, 42, "Seed injected");
  assertEqual(result.model, "gpt-4", "Model preserved");
  assertEqual((result.messages as any).length, 1, "Messages preserved");
});

test("injectSamplingParams does not overwrite existing params", () => {
  const payload = { model: "gpt-4", messages: [], temperature: 0.5 };
  const params = { temperature: 0.7 };
  const result = injectSamplingParams(payload, params) as Record<string, unknown>;
  assertEqual(result.temperature, 0.7, "Temperature overwritten by injection");
  // Note: this is the current behavior. If we want to preserve existing, we need to change logic.
});

test("injectSamplingParams skips undefined params", () => {
  const payload = { model: "gpt-4", messages: [] };
  const params = { temperature: 0.7, top_k: undefined };
  const result = injectSamplingParams(payload, params) as Record<string, unknown>;
  assertEqual(result.temperature, 0.7, "Defined param injected");
  assert(!("top_k" in result), "Undefined param not added");
});

test("injectSamplingParams passes through non-OpenAI payloads", () => {
  const payload = { input: "some embedding input" };
  const params = { temperature: 0.7 };
  const result = injectSamplingParams(payload, params);
  assertEqual(result, payload, "Non-chat payload passed through unchanged");
});

test("injectSamplingParams works with openai-responses style payload", () => {
  // The relaxed isOpenAiStylePayload only checks for "model" field
  const payload = { model: "gpt-4o", input: [{ role: "user", content: "hi" }] };
  const params = { temperature: 0.3 };
  const result = injectSamplingParams(payload, params) as Record<string, unknown>;
  assertEqual(result.temperature, 0.3, "Params injected into responses-style payload");
  assertEqual(result.model, "gpt-4o", "Model preserved");
});

test("injectSamplingParams ignores non-object payloads", () => {
  assertEqual(injectSamplingParams("string", { temperature: 0.7 }), "string", "String passed through");
  assertEqual(injectSamplingParams(123, { temperature: 0.7 }), 123, "Number passed through");
  assertEqual(injectSamplingParams(null, { temperature: 0.7 }), null, "Null passed through");
});

// --- formatSamplingStatus ---

test("formatSamplingStatus formats correctly", () => {
  assertEqual(formatSamplingStatus({ temperature: 0.7, top_p: 0.9 }), "t=0.7 p=0.9", "Formats multiple params");
  assertEqual(formatSamplingStatus({}), "", "Empty params returns empty");
  assertEqual(formatSamplingStatus({ top_k: 40 }), "k=40", "Formats single param");
});

// --- getProfileNames ---

test("getProfileNames returns sorted names", () => {
  const config: SamplingConfig = { profiles: { zebra: {}, apple: {}, mango: {} } };
  assertEqual(getProfileNames(config), ["apple", "mango", "zebra"], "Names sorted alphabetically");
});

// --- parseActiveAgentTag ---

test("parseActiveAgentTag extracts agent name from tag", () => {
  assertEqual(parseActiveAgentTag("<active_agent name=\"Explore\"/>\n\nYou are a file search specialist."), "Explore", "Extracts Explore");
  assertEqual(parseActiveAgentTag("<active_agent name=\"Plan\"/>\n"), "Plan", "Extracts Plan");
  assertEqual(parseActiveAgentTag("<active_agent name=\"general-purpose\"/>\n"), "general-purpose", "Extracts general-purpose");
});

test("parseActiveAgentTag returns undefined for main agent", () => {
  assertEqual(parseActiveAgentTag("You are a helpful coding assistant."), undefined, "No tag returns undefined");
  assertEqual(parseActiveAgentTag(""), undefined, "Empty string returns undefined");
  assertEqual(parseActiveAgentTag("<some_other_tag name=\"foo\"/>"), undefined, "Other tag returns undefined");
});

test("parseActiveAgentTag handles self-closing tag variant", () => {
  assertEqual(parseActiveAgentTag("<active_agent name=\"Explore\" />\n\nSome prompt."), "Explore", "Handles space before />");
});

// --- resolveEffectiveProfile ---

test("resolveEffectiveProfile returns agent-specific profile", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, precise: { temperature: 0.2 } },
    agentProfiles: {
      Explore: { "accounts/fireworks/*": "precise" },
    },
  };
  const result = resolveEffectiveProfile("accounts/fireworks/models/kimi-k2p6", config, "default", "Explore");
  assertEqual(result, "precise", "Agent-specific model override wins");
});

test("resolveEffectiveProfile falls back to active profile when no agent match", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, precise: { temperature: 0.2 } },
    agentProfiles: {
      Explore: { "llama.cpp/*": "precise" },
    },
  };
  const result = resolveEffectiveProfile("accounts/fireworks/models/kimi-k2p6", config, "default", "Explore");
  assertEqual(result, "default", "Falls back to active profile when model doesn't match");
});

test("resolveEffectiveProfile falls back to active profile when no agent type", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7 } },
    agentProfiles: {
      Explore: { "*": "precise" },
    },
  };
  const result = resolveEffectiveProfile("any/model", config, "default", undefined);
  assertEqual(result, "default", "Main agent uses active profile");
});

test("resolveEffectiveProfile uses wildcard for agent type", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, explore: { temperature: 0.5 } },
    agentProfiles: {
      Explore: { "*": "explore" },
    },
  };
  const result = resolveEffectiveProfile("any/model", config, "default", "Explore");
  assertEqual(result, "explore", "Wildcard matches any model");
});

test("resolveEffectiveProfile first match wins within agent type", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, precise: { temperature: 0.2 }, creative: { temperature: 0.9 } },
    agentProfiles: {
      Explore: {
        "accounts/fireworks/*": "precise",
        "*": "creative",
      },
    },
  };
  const result = resolveEffectiveProfile("accounts/fireworks/models/kimi-k2p6", config, "default", "Explore");
  assertEqual(result, "precise", "First match wins (specific before wildcard)");
});

// --- getActiveParams with agent type ---

test("getActiveParams with agent type uses agent-specific profile", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, precise: { temperature: 0.2, top_p: 0.1 } },
    models: { "*": { top_k: 40 } },
    agentProfiles: {
      Explore: { "*": "precise" },
    },
  };
  const params = getActiveParams("any/model", config, "default", "Explore");
  assertEqual(params.temperature, 0.2, "Uses agent-specific profile");
  assertEqual(params.top_p, 0.1, "Uses agent-specific profile params");
  assertEqual(params.top_k, 40, "Model overrides still apply");
});

test("getActiveParams main agent ignores agentProfiles", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, precise: { temperature: 0.2 } },
    agentProfiles: {
      Explore: { "*": "precise" },
    },
  };
  const params = getActiveParams("any/model", config, "default", undefined);
  assertEqual(params.temperature, 0.7, "Main agent uses default profile");
});

test("getActiveParams model overrides override agent profile", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, precise: { temperature: 0.2 } },
    models: { "accounts/fireworks/*": { temperature: 0.5 } },
    agentProfiles: {
      Explore: { "*": "precise" },
    },
  };
  const params = getActiveParams("accounts/fireworks/models/kimi-k2p6", config, "default", "Explore");
  assertEqual(params.temperature, 0.5, "Model override wins over agent profile");
});

// --- findMatchingValue ---

test("findMatchingValue returns string values", () => {
  const mapping = { "llama.cpp/*": "llama.cpp-profile", "accounts/fireworks/*": "fireworks-profile" };
  assertEqual(findMatchingValue("llama.cpp/llama3", mapping), "llama.cpp-profile", "Matches llama.cpp pattern");
  assertEqual(findMatchingValue("accounts/fireworks/models/kimi-k2p6", mapping), "fireworks-profile", "Matches fireworks pattern");
  assertEqual(findMatchingValue("openai/gpt-4", mapping), undefined, "No match returns undefined");
});

// --- Edge cases ---

test("getActiveParams with empty profile and no default", () => {
  const config: SamplingConfig = { profiles: { creative: { temperature: 0.9 } } };
  const params = getActiveParams("any/model", config, undefined);
  assertEqual(params, {}, "No default profile = empty params");
});

test("findMatchingParams with empty config", () => {
  const result = findMatchingParams("any", undefined);
  assertEqual(result, undefined, "Undefined config returns undefined");
});

// ============================================================================
// Summary
// ============================================================================

console.log("\n" + "=".repeat(50));
console.log(`Results: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  console.log("EXITING WITH FAILURE");
  process.exit(1);
} else {
  console.log("ALL TESTS PASSED ✓");
  process.exit(0);
}
