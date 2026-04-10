# Custom LLM Provider

Connect any **OpenAI-compatible** AI endpoint to GitHub Copilot Chat in Visual Studio Code.  
Works out of the box with **Alibaba DashScope (Qwen)**, OpenRouter, and any other OpenAI-compatible API.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.104%2B-007ACC?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=MartinRiha.vscode-custom-llm-provider)
[![Version](https://img.shields.io/badge/version-0.2.9-brightgreen)](CHANGELOG.md)

---

## 🎯 Primary Use Case — Alibaba Cloud Coding Plan

This extension was developed primarily to bring **[Alibaba Cloud Coding Plan](https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=coding-plan#/efm/coding-plan-index)** into Visual Studio Code.

Alibaba's Coding Plan feature in Model Studio lets you run powerful **Qwen Coder** models in full agent mode — editing files, running tests, searching your codebase — all from within GitHub Copilot Chat. This extension bridges the gap by exposing those models directly in the VS Code model picker.

![Alibaba Cloud Coding Plan](images/alibaba-coding-plan.png)

---

## ✨ Features

- Models appear directly in the **Copilot Chat model picker** — no extra setup
- **`@qwen` chat participant** — invoke your custom models anywhere in Copilot Chat
- Full streaming support (Server-Sent Events)
- **Tool calling support** — agent mode, `/fix`, `/edit`, `@workspace` all work
- **Automatic retry with exponential backoff** for network failures and rate limits
- Hot-reload on settings change — no restart needed
- Zero runtime dependencies

---

## 🚀 Quick Start

### 1. Configure your endpoint

Open **User Settings JSON** (`Ctrl+Shift+P` → `Open User Settings (JSON)`) and add:

```json
"customLlm.baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1",
"customLlm.apiKey": "sk-YOUR-API-KEY-HERE"
```

![Settings configuration](images/settings.png)

> **Get your API key** from [Alibaba Cloud Model Studio](https://modelstudio.console.alibabacloud.com) → API Keys section.

### 2. Pick a model in Copilot Chat

Open Copilot Chat (`Ctrl+Alt+I`) → click the model name → your models appear under **Custom LLM**.

> **First time only:** Open `Ctrl+Shift+P` → **Chat: Manage Language Models** → hover over each model → click the **eye icon 👁** to enable it in the picker.

![Model picker with Custom LLM models](images/model-picker.png)

### 3. Use the `@qwen` participant (optional)

Type `@qwen` in Copilot Chat to always route to your custom model, regardless of picker selection.

```
@qwen explain the auth flow in this codebase
@qwen qwen3-coder-plus refactor this function
```

![Using the @qwen chat participant](images/qwen-participant.png)

---

## 🌐 Supported Endpoints

| Provider | Base URL |
|----------|----------|
| Alibaba DashScope (international) | `https://coding-intl.dashscope.aliyuncs.com/v1` |
| Alibaba DashScope (standard) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Any OpenAI-compatible API | custom URL |

---

## ⚙️ Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `customLlm.baseUrl` | DashScope international | Base URL of the OpenAI-compatible endpoint |
| `customLlm.apiKey` | _(empty)_ | API key — leave empty if the endpoint does not require authentication |
| `customLlm.models` | Qwen3 models | List of models to expose in VS Code |

### Default models

All models available in [Alibaba Cloud Coding Plan](https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=coding-plan#/efm/coding-plan-index) are pre-configured out of the box:

| Model ID | Display Name | Provider |
|----------|-------------|----------|
| `qwen3-coder-plus` | Qwen3 Coder Plus | Alibaba |
| `qwen3-coder-next` | Qwen3 Coder Next | Alibaba |
| `qwen3-max-2026-01-23` | Qwen3 Max | Alibaba |
| `qwen3.5-plus` | Qwen3.5 Plus | Alibaba |
| `qwen3.6-plus` | Qwen3.6 Plus | Alibaba |
| `glm-5` | GLM-5 | Zhipu |
| `glm-4.7` | GLM-4.7 | Zhipu |
| `kimi-k2.5` | Kimi K2.5 | Moonshot |
| `MiniMax-M2.5` | MiniMax M2.5 | MiniMax |

### Add or override models

```json
"customLlm.models": [
  { "id": "qwen3-coder-plus", "name": "Qwen3 Coder Plus", "maxInputTokens": 131072, "maxOutputTokens": 8192 },
  { "id": "kimi-k2.5",        "name": "Kimi K2.5",        "maxInputTokens": 131072, "maxOutputTokens": 8192 },
  { "id": "glm-4.7",          "name": "GLM-4.7",          "maxInputTokens": 131072, "maxOutputTokens": 8192 }
]
```

---

## 📋 Requirements

- Visual Studio Code `1.104.0` or later
- GitHub Copilot extension installed and signed in (individual plan)
- An API key for your chosen provider

---

## 🔁 Retry Behavior

The extension automatically retries failed requests with **exponential backoff**:

| Retry | Delay | Triggered by |
|-------|-------|--------------|
| 1st | ~1 second | Rate limit (429), Server errors (5xx) |
| 2nd | ~2 seconds | Same as above |
| 3rd | ~4 seconds | Same as above |

Maximum delay capped at 10 seconds. Request cancellation is never retried.

---

## ⚠️ Known Limitations

- **GitHub Copilot Coding Plan** (GitHub's native multi-step agent mode) is tied to GitHub's own infrastructure and cannot use custom providers. Use [Alibaba Cloud Coding Plan](https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=coding-plan#/efm/coding-plan-index) as a powerful alternative.
- **Inline completions** (ghost text) are provided by GitHub Copilot and cannot be redirected
- Models only appear in the picker on **individual GitHub Copilot plans** (not Business/Enterprise)

---

## 🛠️ Troubleshooting

### Agent mode loops / repeating the same actions

If the model keeps calling the same tool in a loop, switch the model to a larger variant — smaller models sometimes struggle with complex multi-step tool orchestration. Try `qwen3-coder-plus` or `qwen3-max` instead of lighter models.

### Models don't appear in the picker

1. Open `Ctrl+Shift+P` → **Chat: Manage Language Models**
2. Hover over each model in the **Custom LLM** section
3. Click the **eye icon 👁** to make it visible in the picker

If the section doesn't appear at all, check that the extension is active: `Ctrl+Shift+P` → **Extensions: Show Installed Extensions** and verify **Custom LLM Provider** is enabled.

### 401 Unauthorized — "invalid access token or token expired"

This means your API key is missing or incorrect. Fix:

1. Open `Ctrl+Shift+P` → **Custom LLM: Configure endpoint & API key**
2. Paste your API key (starts with `sk-`)
3. Make sure there are no extra spaces around the key

Get your key from [Alibaba Cloud Model Studio](https://modelstudio.console.alibabacloud.com) → **API Keys** section. Note that Coding Plan API keys are separate from regular DashScope keys.

### Requests fail with 404 or empty responses

Check that the `customLlm.baseUrl` ends with `/v1` and the model `id` values match exactly what your provider expects. For DashScope, use `https://coding-intl.dashscope.aliyuncs.com/v1`.

### Settings changes not taking effect

The extension hot-reloads on settings change, but it may take a few seconds. If models still don't update, reload the VS Code window: `Ctrl+Shift+P` → **Developer: Reload Window**.

---

## 🔨 Building from Source

```bash
# Clone the repository
git clone https://github.com/milhaus123/Custom-LLM.git
cd Custom-LLM

# Install dev dependencies
npm install

# Compile TypeScript
npm run compile

# Package as .vsix
npx vsce package

# Install locally
code --install-extension vscode-custom-llm-provider-*.vsix
```

---

## 💖 Support the Project

If this extension saves you time, consider buying me a coffee!

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/martinriha)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub-Sponsor-EA4AAA?logo=github-sponsors)](https://github.com/sponsors/milhaus123)

Your support helps keep the project maintained and updated with new Qwen model releases. 🙏

---

## 📄 License

[MIT](LICENSE) © 2026 Martin Říha
