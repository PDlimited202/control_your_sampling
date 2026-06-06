# Control Your Sampling - Pi Extension

Per-model, per-profile sampling parameter control for the pi coding agent.

Built for OpenAI-compatible API endpoints (Ollama, vLLM, SGLang, LM Studio, OpenRouter, etc.).

## Why This Matters

For self-hosted and open-source models, the default sampling parameters from the API backend are often suboptimal:
- **Too hot (high temperature)**: Models hallucinate, go off-topic, or produce incoherent code
- **Too shallow (low top_p/top_k)**: Models get stuck in repetitive loops or produce bland, unhelpful output
- **Inconsistent across models**: A temperature of 0.7 works for Llama 3 but is too high for Qwen Coder

Commercial APIs (Anthropic, OpenAI) tune these parameters server-side. Self-hosted backends use whatever defaults the backend chooses, which are rarely optimal for coding agents.

This extension gives you fine-grained control over sampling parameters per model, with named profiles for different contexts (coding, planning, creative, etc.).

## Installation

### As a Pi Package (Recommended)

```bash
pi install git:github.com/peter/control_your_sampling
```

### Manual Installation

Copy `sampling.ts` to `~/.pi/agent/extensions/sampling.ts` (global) or `.pi/extensions/sampling.ts` (project-local).

## Configuration

Create `~/.pi/agent/sampling.json` (global) or `.pi/sampling.json` (project-local):

```json
{
  "profiles": {
    "default": {
      "temperature": 0.7,
      "top_p": 0.9,
      "top_k": 40,
      "frequency_penalty": 0,
      "presence_penalty": 0,
      "seed": 42
    },
    "creative": {
      "temperature": 0.9,
      "top_p": 0.95,
      "top_k": 60
    },
    "precise": {
      "temperature": 0.2,
      "top_p": 0.1,
      "top_k": 20
    }
  },
  "models": {
    "ollama/llama*": {
      "temperature": 0.8,
      "top_p": 0.95,
      "top_k": 50,
      "min_p": 0.05
    },
    "ollama/qwen*": {
      "temperature": 0.6,
      "top_p": 0.8,
      "top_k": 30
    },
    "openrouter/*": {
      "temperature": 0.7
    }
  }
}
```

### Config File Locations

| Location | Scope |
|----------|-------|
| `~/.pi/agent/sampling.json` | Global (all projects) |
| `.pi/sampling.json` | Project-local (overrides global) |

Project-local configs are merged on top of global configs. Model-specific overrides in project-local configs take precedence.

### Parameter Reference

All parameters are injected at the top level of the OpenAI chat completions request body. What the backend actually respects depends on your inference server:

| Parameter | Description | Typical Range |
|-----------|-------------|---------------|
| `temperature` | Randomness in sampling. 0 = deterministic, higher = more creative | 0.0 - 2.0 |
| `top_p` | Nucleus sampling. 0.1 = very focused, 0.95 = diverse | 0.0 - 1.0 |
| `top_k` | Top-k sampling. Limits tokens to top K candidates | 1 - 100 |
| `min_p` | Minimum probability relative to the most likely token | 0.0 - 1.0 |
| `frequency_penalty` | Penalize repeated tokens | -2.0 - 2.0 |
| `presence_penalty` | Penalize token presence | -2.0 - 2.0 |
| `repetition_penalty` | Multiplicative penalty for repetition | 1.0 - 2.0 |
| `seed` | Deterministic seed for reproducible outputs | Integer |

Most OpenAI-compatible backends ignore unknown parameters, so you can safely include parameters your specific backend doesn't support (e.g., `min_p` for Ollama, `top_k` for vLLM).

### Model Matching

Model patterns use glob-style matching on `provider/model-id`:

| Pattern | Matches |
|---------|---------|
| `ollama/llama3.1:8b` | Exact match |
| `ollama/llama*` | Any Llama model from Ollama |
| `*/qwen*` | Any Qwen model from any provider |
| `openrouter/*` | Any model from OpenRouter |

Patterns are evaluated in order. The first matching pattern wins.

## Usage

### Switching Profiles

Use the `/sampling` command to view or switch profiles:

```
/sampling              # Show current profile and available profiles
/sampling precise    # Switch to "precise" profile
/sampling default    # Switch back to default
```

Or use the `--sampling-profile` CLI flag:

```bash
pi --sampling-profile precise
```

Or set the environment variable:

```bash
PI_SAMPLING_PROFILE=precise pi
```

### Profile Inheritance

When you switch profiles, the model-specific overrides from the config still apply on top of the profile. The merge order is:

1. Profile defaults (`profiles.<name>`)
2. Model-specific overrides (`models.<pattern>`)

For example, with profile `precise` active and model `ollama/llama3.1:8b`:
- Profile gives `temperature: 0.2, top_p: 0.1`
- Model override gives `temperature: 0.8, top_p: 0.95`
- Final: `temperature: 0.8, top_p: 0.95` (model override wins)

### Status Indicator

The current profile is shown in the pi footer (e.g., `sampling:default`).

### Per-Agent Contexts

For different agent types (main agent, subagents, Plan agents, Explore agents), you can:

1. **Set profile per project**: Put `.pi/sampling.json` in your project with a default profile for that codebase
2. **Pass via CLI flag**: Launch subagents with `--sampling-profile <name>` if your workflow supports passing flags
3. **Use environment variable**: Set `PI_SAMPLING_PROFILE=precise` before launching pi

## Advanced: Custom Profiles

You can define any number of profiles. Common patterns for coding agents:

```json
{
  "profiles": {
    "coding": {
      "temperature": 0.4,
      "top_p": 0.85,
      "top_k": 35
    },
    "planning": {
      "temperature": 0.3,
      "top_p": 0.5,
      "top_k": 25
    },
    "review": {
      "temperature": 0.2,
      "top_p": 0.3,
      "top_k": 20
    },
    "explore": {
      "temperature": 0.8,
      "top_p": 0.95,
      "top_k": 60
    }
  }
}
```

## Troubleshooting

### Parameters not being applied

Enable debug logging by setting `PI_SAMPLING_DEBUG=1`:

```bash
PI_SAMPLING_DEBUG=1 pi
```

This logs the payload before and after modification to `.pi/sampling-debug.log`.

### Model pattern not matching

Check the exact model ID with `/model` or `pi --list-models`. Patterns must match the full `provider/model-id` string.

## License

MIT
