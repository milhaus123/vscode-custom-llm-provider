# Custom LLM Provider

Connect any **OpenAI-compatible** AI endpoint to GitHub Copilot Chat in Visual Studio Code.  
Works out of the box with **Alibaba DashScope (Qwen)**, **MiniMax**, **OpenRouter**, **Ollama**, **LiteLLM**, **vLLM**, and any other API that speaks the OpenAI `/v1/chat/completions` format — including self-hosted models.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.119%2B-007ACC?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=MartinRiha.vscode-custom-llm-provider)
[![Version](https://img.shields.io/badge/version-0.6.2-brightgreen)](CHANGELOG.md)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/martinriha)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub-Sponsor-EA4AAA?logo=github-sponsors)](https://github.com/sponsors/milhaus123)

---

## 🆕 What's New in v0.6.2

- **Fixed: tool calls with empty arguments on non-standard gateways.** Some OpenAI-compatible endpoints (e.g. Gloo AI / Anthropic models via `/ai/v2/guarded`) set `finish_reason: "tool_calls"` on every streamed chunk — including the very first one, before any argument fragments arrive. The extension was finalizing and returning early, reporting the tool call with empty `{}` input, causing `must have required property` errors. Finalization now always happens at `[DONE]` or EOF, where all argument fragments have accumulated.

See the [changelog](CHANGELOG.md) for complete release notes.

---

## 🆕 What's New in v0.6.1

- **Easier reasoning controls** — run **Custom LLM: Set reasoning effort**, select your model, and choose a supported level. Compatible VS Code 1.122+ hosts also receive options for the native model picker.
- **Correct system messages** — instructions received from VS Code retain the `system` role instead of being converted into assistant history.
- **Explicit total context** — set `contextWindow` to reserve the output budget inside a total limit. Existing `maxInputTokens` settings keep their input-only meaning.
- **Clearer failure diagnostics** — retry logs include attempt counts and server request IDs when available; upstream connection errors point to proxy/model-server logs.
- **Regression coverage** — tests verify actual provider registration and serialized requests, reasoning precedence, context budgets, cancellation, and stream failure status.

See the [changelog](CHANGELOG.md) for complete release notes.

---

## 🎯 Primary Use Case — Alibaba Cloud Coding Plan

This extension was developed primarily to bring **[Alibaba Cloud Coding Plan](https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=coding-plan#/efm/coding-plan-index)** into Visual Studio Code.

Alibaba's Coding Plan feature in Model Studio lets you run powerful **Qwen Coder** models in full agent mode — editing files, running tests, searching your codebase — all from within GitHub Copilot Chat. This extension bridges the gap by exposing those models directly in the VS Code model picker.

![Illustrated connection flow: an endpoint connects through Custom LLM Provider to VS Code Chat; API keys are stored in SecretStorage](images/alibaba-coding-plan.png)

*The visuals in this guide illustrate the v0.6 series. They are not VS Code screenshots or live endpoint test results; command names and details below reflect the current version.*

---

## ✨ Features

- Models appear directly in the **Copilot Chat model picker** — no extra setup
- **`@qwen` chat participant** (opt-in) — type `@qwen` in any chat turn to route just that message through your custom model
- **Multi-provider support** — connect Alibaba DashScope, MiniMax, OpenRouter, and any other provider simultaneously, each with its own URL and API key
- **Collision-safe model IDs** — two providers may expose the same upstream model ID without overwriting each other
- **Secure API key storage** — keys are kept in VS Code's encrypted `SecretStorage` instead of provider settings
- **Dynamic model discovery** — models are fetched automatically from each provider's `/v1/models` (or `/model/info` for LiteLLM-compatible endpoints) on startup
- **Stable provider IDs** — providers are identified by a human-readable slug (e.g. `alibaba-dashscope`), so renaming or changing a provider's URL never breaks the model list
- **Capability-aware image input** — attach images only to models that report, inherit, or explicitly enable vision support
- **Tool-result image support** — screenshots and other images returned by tools are forwarded to multimodal models
- Full streaming support (Server-Sent Events)
- **Capability-aware tool calling** — agent mode, `/fix`, `/edit`, and `@workspace` are enabled only for compatible models
- **Automatic retry with exponential backoff** for network failures and rate limits
- Hot-reload on settings change — no restart needed
- Zero runtime dependencies

---

## 🚀 Quick Start

**Install from the VS Code Marketplace:**
[Custom LLM Provider](https://marketplace.visualstudio.com/items?itemName=MartinRiha.vscode-custom-llm-provider) — or search for **"Custom LLM Provider"** in the VS Code Extensions panel (`Ctrl+Shift+X`).

### 1. Add your first provider

Open the Command Palette (`Ctrl+Shift+P`) and run **Custom LLM: Add provider**.

The wizard will ask for:

1. **Provider name** — e.g. `Alibaba DashScope`
2. **Base URL** — e.g. `https://coding-intl.dashscope.aliyuncs.com/v1`
3. **API key** — your `sk-…` key, or empty for an unauthenticated local endpoint

After saving, the extension automatically fetches available models from the provider.

The API key is stored in VS Code's encrypted secret storage, not in your user or workspace `settings.json`.

![Illustrated Command Palette setup: Add provider stores the key in SecretStorage; Manage models saves capabilities and limits per model](images/settings.png)

> **Get your API key** from [Alibaba Cloud Model Studio](https://modelstudio.console.alibabacloud.com) → API Keys section.  
> Note that Coding Plan API keys are separate from regular DashScope keys.

### 2. Pick a model in Copilot Chat

Open Copilot Chat (`Ctrl+Alt+I`) → click the model name → your models appear under **Custom LLM**.

> **First time only:** Open `Ctrl+Shift+P` → **Chat: Manage Language Models** → hover over each model → click the **eye icon 👁** to enable it in the picker.

Check capabilities in **Custom LLM: Manage models**. For example, the extension's `zai-org/GLM-5.3` profile enables text and tool calling, disables image input, and offers `low`, `high`, or `max` thinking effort. Endpoint metadata or explicit overrides can change the resolved capabilities. The same upstream model ID at two providers remains two separate choices.

![Illustrated GLM-5.3 profile: text and tools enabled, images disabled, low/high/max reasoning; identical model IDs remain separate across providers](images/model-picker.png)

### 3. Use the `@qwen` participant (optional)

Type `@qwen` at the start of a message to route **that single turn** through your custom model — regardless of which model is selected in the picker.

```text
@qwen explain this pasted function: ...
@qwen qwen3-coder-plus summarize this pasted code: ...
```

> **Per-turn, not sticky:** since v0.4.5 the participant is **not sticky** — you have to type `@qwen` every time you want it. Without `@qwen`, the message goes to whatever model you picked in the model picker (including original GitHub Copilot models like GPT-4 or Claude). This prevents the participant from accidentally hijacking native Copilot turns. If you want to always use your custom model, select it in the picker instead.

The participant forwards your **plain-text prompt and text history**. It does not forward file attachments, images, or tool results, and it does not run an agent tool loop. For those workflows, select a compatible custom model in the **model picker** instead.

![Illustrated routing comparison: the model picker supports ongoing work and compatible tools/images; @qwen handles one text-only turn](images/qwen-participant.png)

---

## 🌐 Supported Endpoints

| Provider | Base URL |
| -------- | -------- |
| Alibaba DashScope (international / Coding Plan) | `https://coding-intl.dashscope.aliyuncs.com/v1` |
| Alibaba DashScope (standard) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| MiniMax ✅ | `https://api.minimaxi.chat/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Ollama (local) | `http://localhost:11434/v1` |
| LiteLLM proxy | `http://localhost:4000/v1` |
| vLLM | `http://localhost:8000/v1` |
| Any OpenAI-compatible API | custom URL |

---

## 🔌 Multi-Provider Support

You can connect **multiple providers at once** — for example, use Alibaba DashScope and OpenRouter side by side. Each provider has its own URL and API key; models from all providers are merged into a single list in the Copilot Chat picker. Internally, the extension identifies a model by `providerId + upstream model ID`, so providers can safely expose the same ID.

**Add a provider:**

```text
Ctrl+Shift+P → Custom LLM: Add provider
```

**Manage providers (edit / remove):**

```text
Ctrl+Shift+P → Custom LLM: Manage providers
```

**Manage model capabilities and limits:**

```text
Ctrl+Shift+P → Custom LLM: Manage models
```

**Refresh the model list:**

```text
Ctrl+Shift+P → Custom LLM: Refresh model list from API
```

---

## ⚙️ Settings

### Provider configuration

Providers are stored in the `customLlm.providers` array. Each entry has the following fields:

| Field | Description |
| ----- | ----------- |
| `id` | Auto-generated slug used as a stable internal identifier (e.g. `"alibaba-dashscope"`). Set automatically — you don't need to write this by hand. |
| `name` | Display name shown in the UI and info messages (e.g. `"Alibaba DashScope"`) |
| `baseUrl` | Base URL ending with `/v1` |

The `id` slug is derived from the provider name when you add it via the wizard. It stays stable even if you later rename the provider or change its URL — so the model list never gets orphaned, and the API key stays attached to the right provider.

You can also edit settings directly in **User Settings JSON** (`Ctrl+Shift+P` → `Open User Settings (JSON)`):

```json
"customLlm.providers": [
  {
    "id": "alibaba-dashscope",
    "name": "Alibaba DashScope",
    "baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1"
  },
  {
    "id": "minimax",
    "name": "MiniMax",
    "baseUrl": "https://api.minimaxi.chat/v1"
  },
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "baseUrl": "https://openrouter.ai/api/v1"
  }
]
```

### 🔐 API keys (v0.5.0+)

Starting with v0.5.0, API keys are kept out of `settings.json` during normal operation. Keys are stored through VS Code's [`SecretStorage`](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) API, which VS Code documents as encrypted. On desktop, VS Code uses Electron's `safeStorage`; the underlying implementation varies by platform.

Each key is stored under the provider's stable `id`, so renaming a provider or changing its endpoint keeps the key attached to the correct provider.

> `SecretStorage` is global to this extension on the current machine, not scoped to a workspace. Provider configurations that use the same `id` therefore share the same stored key.

Set or change a key through the UI:

```text
Ctrl+Shift+P → Custom LLM: Manage providers → <provider> → Edit API key
```

Leaving the input empty removes the stored key. Removing a provider deletes its key too.

Do not add an `apiKey` property to `customLlm.providers` manually. Because keys live outside settings, they are not exposed through user or workspace `settings.json`. VS Code does **not** sync `SecretStorage` across machines, so enter each key once per machine.

#### Upgrading to v0.5.0

On startup, the extension scans user, workspace, and workspace-folder configurations. Any non-empty `apiKey` found in `customLlm.providers` is stored in `SecretStorage`, then the `apiKey` property is removed from that settings scope. The same cleanup runs again if `customLlm.providers` is edited later. A notification reports how many keys were moved.

Existing provider entries without an `id` are upgraded automatically. Legacy `customLlm.baseUrl` / `customLlm.apiKey` settings (pre-v0.4.0) and the old `providerUrl` model field are migrated as well.

> A key that has already leaked into a committed `settings.json` should be rotated at the provider — migration removes the value locally, but cannot un-publish it.

### Model list

`customLlm.models` is auto-populated by model discovery and does not normally need to be edited manually. Use **Custom LLM: Manage models** for common changes. Discovery merges by provider plus upstream model ID, and existing overrides win over newly reported metadata.

| Field | Description |
| ----- | ----------- |
| `id` | Model identifier sent to the provider |
| `name` | Display name shown in the model picker |
| `providerId` | Stable provider slug referenced by the model |
| `maxInputTokens` | Input-only token limit reported to VS Code, unless `contextWindow` is set |
| `maxOutputTokens` | Output budget — reported to VS Code and sent as `max_tokens` on every request |
| `contextWindow` | Optional total input + output limit; input is calculated as this value minus `maxOutputTokens` |
| `imageInput` | Optional vision override; `true` enables and `false` disables image input |
| `toolCalling` | Optional tool-calling override for agent mode |
| `hidden` | Optional; `true` keeps the model out of the Copilot model picker |
| `thinkingEffort` | Optional per-model reasoning level; omit to inherit the global setting, or use `auto` for the provider default |

The extension first uses an explicit model value, then endpoint metadata, then its known-model profile. An unknown capability is disabled. LiteLLM `/model/info` can report `supports_vision` and `supports_function_calling`; some richer `/models` responses expose input modalities and supported parameters. Use **Manage models** when a generic endpoint does not publish this metadata.

If an upstream server rejects an actual image request, the extension records `imageInput: false`, refreshes the model registration, and does not retry the invalid request.

#### Hiding models from the picker

Provider catalogues list more than chat models — text-to-speech, image and video generation, embeddings, rerankers. They cannot serve a chat request, so they only add noise to the model picker.

Set `"hidden": true` on any entry to keep it out of the picker:

```json
{
  "id": "qwen-tts",
  "name": "Qwen Tts",
  "providerId": "alibaba-dashscope",
  "maxInputTokens": 131072,
  "maxOutputTokens": 8192,
  "hidden": true
}
```

Hide rather than delete: a deleted entry is added back by the next model refresh, a hidden one stays hidden. Hiding only affects the picker — the entry stays in your settings, so a chat already using that model keeps working, and `"hidden": false` brings it straight back.

Endpoints that report a model's mode — LiteLLM's `/model/info` — get this for free: models whose `mode` is not `chat` or `completion`, and deployments the proxy marks as `blocked`, are hidden the first time they are discovered. Only the first time: once an entry exists, the flag is yours, so unhiding one is never undone by a refresh. Plain OpenAI-compatible `/models` responses (Alibaba DashScope among them) carry no mode at all, so nothing is hidden automatically there — set the flag by hand.

#### Total context versus input budget

`maxInputTokens` is an **input-only** allowance. If you mean a total capacity of 1,000,000 tokens, set `contextWindow` instead. The extension reserves `maxOutputTokens` within that total:

```json
{
  "id": "zai-org/GLM-5.3",
  "name": "Zai Org/GLM 5 3",
  "providerId": "custom-alza",
  "contextWindow": 1000000,
  "maxInputTokens": 983616,
  "maxOutputTokens": 16384
}
```

The input limit is derived from `contextWindow`, even if the stored `maxInputTokens` differs. Changing the output budget therefore keeps the same total. The total must be a whole number greater than the output budget; use the actual capacity of your deployment, not a value inferred from its model name.

You can configure these values through **Custom LLM: Manage models → Total context window (input + output)**. Choosing **Maximum input tokens** clears an explicit total and restores input-only configuration. The model tooltip and **Custom LLM** output channel show the exact input, output, and total counts.

**Why could 1M appear as 2M?** VS Code 1.122's picker tooltip adds input and output, then rounds large totals upward to whole millions. Thus `1000000 + 16384 = 1016384` displays as `2M`; it does not grant the model two million tokens. The configuration above makes the sum exactly `1M`. See the [VS Code 1.122 picker formatter](https://github.com/microsoft/vscode/blob/1.122.0/src/vs/workbench/contrib/chat/browser/widget/input/chatModelPicker.ts#L1505).

#### Output budget and reasoning models

`maxOutputTokens` is sent verbatim as `max_tokens`. Reasoning models (GLM, Qwen thinking modes, DeepSeek-R1, QwQ …) spend that budget on their chain of thought before writing any answer, so a budget that is too small produces a reply with no content at all. If **View → Output → Custom LLM** shows

```text
⚠️  EMPTY CONTENT — model produced 27615 chars of reasoning but 0 chars of content.
```

raise `maxOutputTokens` for that model; 32768 or more suits most reasoning models. The request log line shows the value actually sent as `max_tokens=…`.

Discovery fills the field in from the endpoint when it reports one — `max_output_tokens` or `max_tokens` from LiteLLM's `/model/info`, `max_completion_tokens` or `context_length` from `/models`. Existing values and overrides survive later refreshes; only a newly discovered model with no reported limit falls back to a built-in guess.

#### Thinking and reasoning effort

Open the Command Palette and select a level without editing JSON:

```text
Ctrl+Shift+P → Custom LLM: Set reasoning effort → <model> → Low / High / Max
```

The available levels depend on the model. For `zai-org/GLM-5.3`, choose **Low**, **High**, or **Max**. The same control is available through **Custom LLM: Manage models → Reasoning effort (thinking)**.

VS Code renders the native controls, but the extension must supply their options and translate the selected value into API parameters. On compatible **VS Code 1.122+** hosts, look for an effort button or a configuration/gear menu associated with the selected model; its placement depends on the Chat UI. This integration uses VS Code's evolving optional `chatProvider` configuration channel. If no native control appears, the Command Palette command remains available on every supported VS Code version. See the [VS Code configuration schema](https://github.com/microsoft/vscode/blob/1.122.0/src/vscode-dts/vscode.proposed.chatProvider.d.ts).

Selection priority is **request override → native model picker → per-model `thinkingEffort` → global `customLlm.thinkingEffort`**. In the native picker, choose **Use extension setting** to use the command/settings value again. In the command, **Use global setting** removes the per-model override. **Provider default (auto)** is different: it explicitly sends no reasoning parameters, even when the global setting is `high`.

Namespaced IDs are normalized before selecting an adapter, while the original model ID is still sent upstream. **View → Output → Custom LLM** logs the selected effort, its source, and the translated parameters for each request.

| Model family | Request fields | Supported behavior |
| ------------ | -------------- | ------------------ |
| Qwen | `enable_thinking`, `thinking_budget` | Off through max budget |
| GLM-5.3 | `thinking.type`, `reasoning_effort` | `low`, `high`, `max`; thinking cannot be disabled |
| OpenAI o-series, GPT-5, DeepSeek-V4 | `reasoning_effort` | `low`, `medium`, `high` |
| Unknown family | None | A warning is logged; no guessed parameter is sent |

> **Editing over Remote SSH:** `customLlm.models` is a user setting, so it lives on whichever machine runs the extension host. In a Remote SSH window that is the **remote** host — edit it there, not in your local `settings.json`.

### Default models

If no providers are configured and the model list is empty, the extension adds these built-in defaults (all available in [Alibaba Cloud Coding Plan](https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=coding-plan#/efm/coding-plan-index)):

| Model ID | Display Name | Provider | Context |
| -------- | ----------- | -------- | ------- |
| `qwen3-coder-plus` | Qwen3 Coder Plus | Alibaba DashScope | 128K |
| `qwen3-coder-next` | Qwen3 Coder Next | Alibaba DashScope | 128K |
| `qwen3-max-2026-01-23` | Qwen3 Max | Alibaba DashScope | 128K |
| `qwen3.5-plus` | Qwen3.5 Plus | Alibaba DashScope | 1M |
| `qwen3.6-plus` | Qwen3.6 Plus | Alibaba DashScope | 1M |
| `glm-5` | GLM-5 | Zhipu | 200K |
| `glm-4.7` | GLM-4.7 | Zhipu | 128K |
| `kimi-k2.5` | Kimi K2.5 | Moonshot | 256K |
| `MiniMax-M2.5` | MiniMax M2.5 | MiniMax ✅ | 256K |

> **MiniMax** models (`MiniMax-M2.5` and others) are fully supported — connect via `https://api.minimaxi.chat/v1` with your MiniMax API key.

---

## 🛠️ Commands

| Command | Description |
| ------- | ----------- |
| `Custom LLM: Add provider` | Guided wizard to add a new provider (name → URL → API key → auto-discover models) |
| `Custom LLM: Manage providers` | List, edit, or remove configured providers |
| `Custom LLM: Manage models` | Configure image input, tool calling, reasoning, input/output/total limits, and picker visibility |
| `Custom LLM: Set reasoning effort` | Select a model and its reasoning depth, global inheritance, or provider default |
| `Custom LLM: Refresh model list from API` | Manually re-fetch models from all configured providers |
| `Custom LLM: Test connection` | Send a test request to each configured provider and report the result |

---

## 📋 Requirements

- Visual Studio Code `1.119.0` or later
- GitHub Copilot extension installed and signed in (individual plan)
- An API key if your chosen provider requires authentication

---

## 🔁 Retry Behavior

The extension automatically retries failed requests with **exponential backoff**:

| Retry | Delay | Triggered by |
| ----- | ----- | ------------ |
| 1st | ~1 second | Rate limit (429), Server errors (5xx) |
| 2nd | ~2 seconds | Same as above |
| 3rd | ~4 seconds | Same as above |

Maximum delay is capped at 10 seconds. Network failures and HTTP `408` are also retried; permanent `400/401/403` failures are not. Cancellation interrupts retry backoff and is never retried. There are at most four attempts (one initial request plus three retries), recorded in **View → Output → Custom LLM**.

---

## ⚠️ Known Limitations

- **GitHub Copilot Coding Plan** (GitHub's native multi-step agent mode) is tied to GitHub's own infrastructure and cannot use custom providers. Use [Alibaba Cloud Coding Plan](https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=coding-plan#/efm/coding-plan-index) as a powerful alternative.
- **Inline completions** (ghost text) are provided by GitHub Copilot and cannot be redirected
- Models only appear in the picker on **individual GitHub Copilot plans** (not Business/Enterprise)
- VS Code's extension-provider API does not currently expose a supported channel for reporting upstream token usage to the Chat UI. Usage remains available in **View → Output → Custom LLM**.
- Native reasoning controls use an evolving optional VS Code API and may not appear in every host/UI. **Custom LLM: Set reasoning effort** and global/per-model settings remain the fallback.

---

## 🛠️ Troubleshooting

### I cannot find reasoning effort

Install v0.6.1 or later, reload the VS Code window, and run **Custom LLM: Set reasoning effort** from `Ctrl+Shift+P`. Select the correct model/provider pair. If you previously selected a value in the native picker, return it to **Use extension setting** so it no longer overrides the command's value. The request log confirms the effective selection and its source.

### LiteLLM returns 500: "Connection error"

This response means the endpoint reports a connection failure toward its upstream service; it does not identify the underlying server-side cause. The extension retries transient failures, but cannot repair an unavailable model server or a proxy routing/network problem. Check the proxy and model-server logs at the request timestamp, using the upstream request ID from **Custom LLM** output when one was returned. VS Code's **Client Request Id** is a separate identifier.

Version 0.6.1 also fixes a separate request-conversion bug: VS Code system instructions were previously sent as assistant history. A `500` response alone does not establish that this bug caused the outage. If the failure persists after updating, server-side logs are still needed.

### Models lose their provider after changing a provider's URL (pre-v0.5.0)

Fixed in **v0.5.0**. Providers now have a stable slug `id` (e.g. `"alibaba-dashscope"`) that models reference instead of the raw endpoint URL. Changing a provider's URL no longer orphans its models. Existing configs are migrated automatically on first launch.

### "Add Models" → "Custom LLM" shows no input dialogs (v0.4.8)

Fixed in **v0.4.8**. In earlier versions, clicking **Add Models → Custom LLM** in the Copilot model picker opened the management command, but the name / URL / API key dialogs immediately disappeared without any input. The root cause was that VS Code 1.104+ keeps the model-picker webview in focus when it invokes the `managementCommand`, causing any synchronous `showInputBox` call to be dismissed as soon as the webview stole focus back. The fix adds a short settle-time so the picker panel fully closes before the first input dialog opens.

### Custom model can't be invoked — Copilot loops on `gpt-4o-mini` requests (v0.4.7)

Fixed in **v0.4.7**. If a custom model appeared to do nothing and VS Code kept sending auxiliary `gpt-4o-mini` (`*.copilotmd`) requests in a loop, the extension was inadvertently writing model IDs into Copilot's BYOK settings (`github.copilot.chat.customOAIModels`). When Copilot found the same ID in both registrations, it routed via BYOK, found no API key there, and silently looped. The fix removes that secondary write entirely. The extension also cleans up stale BYOK entries left by earlier versions on startup.

### Original Copilot models reply "no input given" / context fills to ~95% in a loop

Fixed in **v0.4.5**. In earlier versions, the `@qwen` participant was sticky, so once you used it, every subsequent message was silently routed through the participant — even when you switched the picker back to a built-in Copilot model (GPT-4, Claude, etc.). On agent-mode turns where the actual content was in references/tool results rather than plain prompt text, the participant forwarded an empty user message, the model replied "what do you need?", and the loop repeated until the context filled.

If you see this on **0.4.4 or earlier**, update to 0.4.5+. As a workaround on older versions, fully clear the `@qwen` mention from the prompt and reload the chat.

### Agent mode loops / repeating the same actions

If the model keeps calling the same tool in a loop, switch to a larger variant — smaller models sometimes struggle with complex multi-step tool orchestration. Try `qwen3-coder-plus` or `qwen3-max` instead of lighter models.

### Models don't appear in the picker

1. Open `Ctrl+Shift+P` → **Chat: Manage Language Models**
2. Hover over each model in the **Custom LLM** section
3. Click the **eye icon 👁** to make it visible in the picker

If the section doesn't appear at all, check that the extension is active: `Ctrl+Shift+P` → **Extensions: Show Installed Extensions** and verify **Custom LLM Provider** is enabled.

To force a model refresh: `Ctrl+Shift+P` → **Custom LLM: Refresh model list from API**.

### 401 Unauthorized — "invalid access token or token expired"

Your API key is missing or incorrect. Fix:

1. Open `Ctrl+Shift+P` → **Custom LLM: Manage providers**
2. Select your provider → **Edit API key**
3. Paste your API key (starts with `sk-`)
4. Make sure there are no extra spaces around the key

Get your key from [Alibaba Cloud Model Studio](https://modelstudio.console.alibabacloud.com) → **API Keys** section.

### Requests fail with 404 or empty responses

Check that the `baseUrl` ends with `/v1` and the model `id` values match exactly what your provider expects. For DashScope, use `https://coding-intl.dashscope.aliyuncs.com/v1`.

### Settings changes not taking effect

The extension hot-reloads on settings change, but it may take a few seconds. If models still don't update, reload the VS Code window: `Ctrl+Shift+P` → **Developer: Reload Window**.

### Inspect request diagnostics

Open **View → Output** and select **Custom LLM**. Each request includes the selected model, reasoning effort and its source, timing, streamed content and tool-call counts, finish reason, and whether images were included. Retries include the next attempt number, delay, HTTP status, and upstream request ID when available. Token usage is logged as structured JSON when the provider reports it.

### Image attachment returns an error

Not all models support image input. If you see `"This model does not support image input"`, switch to a multimodal model. The extension marks a model text-only after a confirmed upstream rejection so later requests do not repeat the same failure.

Generic OpenAI-compatible `/models` responses often omit vision metadata. Unknown models therefore default to text-only. Run **Custom LLM: Manage models → Image input → Enabled** only when you know the selected model accepts images. An explicit choice survives model refreshes.

### Agent mode is unavailable for a model

Tool calling is advertised only when endpoint metadata, a known model profile, or your override enables it. For an otherwise compatible model whose endpoint omits capability metadata, run **Custom LLM: Manage models → Tool calling → Enabled**.

### The model says it cannot see a screenshot from a tool

Images returned by tools (`#browser/screenshotPage` and similar) are forwarded to the model as a separate message right after the tool result, because the OpenAI chat schema only accepts plain text in a `tool` message. If the model still reports it cannot see the image, check **View → Output → Custom LLM**: the request line shows `images=yes` when image content was actually sent. If it shows `images=no`, verify the model's resolved vision capability in **Custom LLM: Manage models**.

### Migrating from v0.4.x or earlier

Update to v0.5.0 and reload VS Code. Keys in v0.4.x `customLlm.providers` entries are moved to secret storage automatically. The older single-provider `customLlm.baseUrl` and `customLlm.apiKey` settings are also migrated, with the key stored securely.

If a migrated key is missing, do not put it back into `settings.json`. Run **Custom LLM: Manage providers**, select the provider, and choose **Edit API key**. You must also repeat this on each additional machine because VS Code does not sync secret storage.

---

## 🔨 Building from Source

```bash
# Clone the repository
git clone https://github.com/milhaus123/vscode-custom-llm-provider.git
cd vscode-custom-llm-provider

# Install the locked dependency versions
npm ci

# Compile TypeScript
npm run compile

# Package as .vsix
npx vsce package

# Install locally
code --install-extension vscode-custom-llm-provider-*.vsix
```

Maintainers can publish the current version with `npx vsce publish`, or increment and publish it in one step with `npx vsce publish patch`.

---

## 💖 Support the Project

If this extension saves you time, consider buying me a coffee!

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/martinriha)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub-Sponsor-EA4AAA?logo=github-sponsors)](https://github.com/sponsors/milhaus123)

Your support helps keep the project maintained and updated with new model releases. 🙏

---

## 📄 License

[MIT](LICENSE) © 2026 Martin Říha
