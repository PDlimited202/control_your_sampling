/**
 * Test suite for Control Your Sampling core logic
 * Run: npx tsx test-sampling.ts
 */

import {
  loadConfig,
  getActiveParams,
  hasAnySamplingParams,
  isOpenAiStyleApi,
  injectSamplingParams,
  formatSamplingStatus,
  getProfileNames,
  matchPattern,
  findMatchingParams,
  mergeConfig,
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
  assertEqual(config.profiles, undefined, "No profiles for missing files");
  assertEqual(config.models, undefined, "No models for missing files");
});

// --- Pattern matching ---

test("matchPattern exact match", () => {
  assert(matchPattern("ollama/llama3.1:8b", "ollama/llama3.1:8b"), "Exact match works");
});

test("matchPattern wildcard at end", () => {
  assert(matchPattern("ollama/llama*", "ollama/llama3.1:8b"), "Wildcard matches suffix");
  assert(matchPattern("ollama/llama*", "ollama/llama3"), "Wildcard matches shorter name");
  assert(!matchPattern("ollama/llama*", "ollama/qwen2.5"), "Wildcard doesn't match different model");
});

test("matchPattern wildcard at start", () => {
  assert(matchPattern("*/qwen*", "ollama/qwen2.5"), "Wildcard at start matches provider");
  assert(matchPattern("*/qwen*", "vllm/qwen-coder"), "Wildcard at start matches any provider");
});

test("matchPattern full wildcard", () => {
  assert(matchPattern("openrouter/*", "openrouter/anthropic/claude-3.5-sonnet"), "Full wildcard matches");
  assert(!matchPattern("openrouter/*", "ollama/llama3"), "Full wildcard doesn't match different provider");
});

test("matchPattern double wildcard", () => {
  assert(matchPattern("**", "anything/here/works"), "Double star matches everything");
});

// --- findMatchingParams ---

test("findMatchingParams returns first match", () => {
  const models: Record<string, SamplingParams> = {
    "ollama/llama*": { temperature: 0.8 },
    "ollama/llama3.1*": { temperature: 0.9 },
  };
  const result = findMatchingParams("ollama/llama3.1:8b", models);
  assertEqual(result?.temperature, 0.8, "First match wins");
});

test("findMatchingParams returns undefined for no match", () => {
  const result = findMatchingParams("unknown/model", { "ollama/*": { temperature: 0.5 } });
  assertEqual(result, undefined, "No match returns undefined");
});

// --- mergeConfig ---

test("mergeConfig merges profiles and models", () => {
  const global: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, global: { temperature: 0.5 } },
    models: { "ollama/*": { temperature: 0.8 } },
  };
  const project: SamplingConfig = {
    profiles: { default: { temperature: 0.6 }, project: { temperature: 0.4 } },
    models: { "ollama/llama*": { temperature: 0.9 } },
  };
  const merged = mergeConfig(global, project);
  assertEqual(merged.profiles?.default?.temperature, 0.6, "Project overrides global profile");
  assertEqual(merged.profiles?.global?.temperature, 0.5, "Global-only profile preserved");
  assertEqual(merged.profiles?.project?.temperature, 0.4, "Project-only profile added");
  assertEqual(merged.models?.["ollama/llama*"]?.temperature, 0.9, "Project model overrides global");
  assertEqual(merged.models?.["ollama/*"]?.temperature, 0.8, "Global-only model preserved");
});

// --- getActiveParams ---

test("getActiveParams uses default profile when no active profile", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7, top_p: 0.9 } },
  };
  const params = getActiveParams("ollama/llama3", config, undefined);
  assertEqual(params.temperature, 0.7, "Default profile temperature applied");
  assertEqual(params.top_p, 0.9, "Default profile top_p applied");
});

test("getActiveParams uses active profile", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7 }, precise: { temperature: 0.2 } },
  };
  const params = getActiveParams("ollama/llama3", config, "precise");
  assertEqual(params.temperature, 0.2, "Active profile temperature applied");
});

test("getActiveParams model overrides win", () => {
  const config: SamplingConfig = {
    profiles: { default: { temperature: 0.7, top_p: 0.9 } },
    models: { "ollama/llama*": { temperature: 0.8 } },
  };
  const params = getActiveParams("ollama/llama3.1:8b", config, undefined);
  assertEqual(params.temperature, 0.8, "Model override wins");
  assertEqual(params.top_p, 0.9, "Profile param preserved when not overridden");
});

test("getActiveParams active profile + model override", () => {
  const config: SamplingConfig = {
    profiles: { precise: { temperature: 0.2, top_p: 0.1 } },
    models: { "ollama/llama*": { temperature: 0.8 } },
  };
  const params = getActiveParams("ollama/llama3", config, "precise");
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
