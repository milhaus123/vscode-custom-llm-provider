# Custom LLM Provider

Connect any **OpenAI-compatible** AI endpoint to GitHub Copilot Chat in Visual Studio Code.  
Works out of the box with **Alibaba DashScope (Qwen)**, OpenRouter, and any other OpenAI-compatible API.

---

## Features

- Models appear directly in the **Copilot Chat model picker** — no extra setup
- **`@qwen` chat participant** — invoke your custom models anywhere in Copilot Chat
- Full streaming support (Server-Sent Events)
- **Tool calling support** — agent mode, `/fix`, `/edit`, `@workspace` all work
- **Automatic retry with exponential backoff** for network failures and rate limits
- Hot-reload on settings change — no restart needed
- Zero runtime dependencies

---

## Quick Start

### 1. Configure your endpoint

Open **User Settings JSON** (`Ctrl+Shift+P` → `Open User Settings (JSON)`) and add:

```json
"customLlm.baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1",
"customLlm.apiKey": "sk-YOUR-API-KEY-HERE"
```

### 2. Pick a model in Copilot Chat

Open Copilot Chat (`Ctrl+Alt+I`) → click the model name → your models appear under **Custom LLM**.

> **First time only:** Open `Ctrl+Shift+P` → **Chat: Manage Language Models** → hover over each model → click the **eye icon 👁** to enable it in the picker.

### 3. Use the `@qwen` participant (optional)

Type `@qwen` in Copilot Chat to always route to your custom model, regardless of picker selection.

```
@qwen explain the auth flow in this codebase
@qwen qwen3-coder-plus refactor this function
```

---

## Supported Endpoints

| Provider | Base URL |
|----------|----------|
| Alibaba DashScope (international) | `https://coding-intl.dashscope.aliyuncs.com/v1` |
| Alibaba DashScope (standard) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Any OpenAI-compatible API | custom URL |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `customLlm.baseUrl` | DashScope international | Base URL of the OpenAI-compatible endpoint |
| `customLlm.apiKey` | _(empty)_ | API key — leave empty if the endpoint does not require authentication |
| `customLlm.models` | Qwen3 models | List of models to expose in VS Code |

### Default models

```json
"customLlm.models": [
  { "id": "qwen3-coder-plus",     "name": "Qwen3 Coder Plus", "maxInputTokens": 131072, "maxOutputTokens": 8192 },
  { "id": "qwen3-coder-next",     "name": "Qwen3 Coder Next", "maxInputTokens": 131072, "maxOutputTokens": 8192 },
  { "id": "qwen3-max-2026-01-23", "name": "Qwen3 Max",        "maxInputTokens": 131072, "maxOutputTokens": 8192 },
  { "id": "qwen3.5-plus",         "name": "Qwen3.5 Plus",     "maxInputTokens": 131072, "maxOutputTokens": 8192 }
]
```

### Add your own models

```json
"customLlm.models": [
  { "id": "kimi-k2.5", "name": "Kimi K2.5", "maxInputTokens": 131072, "maxOutputTokens": 8192 },
  { "id": "glm-4.7",   "name": "GLM-4.7",   "maxInputTokens": 131072, "maxOutputTokens": 8192 }
]
```

---

## Requirements

- Visual Studio Code `1.104.0` or later
- GitHub Copilot extension installed and signed in (individual plan)
- An API key for your chosen provider

---

## Retry Behavior

The extension automatically retries failed requests with **exponential backoff**:

| Retry | Delay | Triggered by |
|-------|-------|--------------|
| 1st | ~1 second | Rate limit (429), Server errors (5xx) |
| 2nd | ~2 seconds | Same as above |
| 3rd | ~4 seconds | Same as above |

Maximum delay capped at 10 seconds. Request cancellation is never retried.

---

## Known Limitations

- **GitHub Copilot Coding Plan** (multi-step agent mode) is tied to GitHub's own infrastructure and cannot use custom providers
- **Inline completions** (ghost text) are provided by GitHub Copilot and cannot be redirected
- Models only appear in the picker on **individual GitHub Copilot plans** (not Business/Enterprise)

---

## Author

**Martin Říha**  
[github.com/MartinRiha](https://github.com/MartinRiha)

---

## License

MIT
