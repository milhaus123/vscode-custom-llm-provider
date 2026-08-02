# Changelog

## v0.5.2 — August 2026

### Bug fixes

- **Fixed:** `maxOutputTokens` had no effect above 8192. Every request was clamped with `Math.min(model.maxOutputTokens, 8192)`, so raising the setting changed nothing — reasoning models spent the whole budget thinking and returned empty content, and the extension's own defaults (`qwen3.6-plus` at 65536, `kimi-k2.5` at 32768) were never reachable either. The configured value is now sent as-is; 8192 remains only as a fallback for a missing or invalid one. Fixes [#3](https://github.com/milhaus123/vscode-custom-llm-provider/issues/3).
- **Fixed:** model discovery ignored `max_output_tokens` from LiteLLM's `/model/info` — only `max_tokens` was read — so a correctly configured proxy still landed on the built-in default. `max_output_tokens`, `max_completion_tokens` and OpenRouter's `top_provider` limits are now read as well, and non-positive values are treated as "not reported" instead of being taken literally.
- **Fixed:** the built-in token-limit table was matched against the raw model ID, so namespaced proxy IDs such as `tensorix/z-ai/glm-5.2` never matched `glm-5` and silently fell back to 8192 output tokens. The last path segment is now tried too, case-insensitively.
- **Fixed:** model discovery replaced existing entries wholesale, resetting hand-tuned `maxInputTokens` / `maxOutputTokens` (and a custom `name`) on every refresh. Per field, a value reported by the endpoint wins, then whatever is already in settings, then the built-in guess.
- **Fixed:** the EMPTY CONTENT warning reported the *configured* `maxOutputTokens` while the request had actually sent the clamped 8192, and advised raising a number the user had often already raised. It now reports the value really sent, flags a mismatch with the configured one, and points at the right setting.

### Changes

- The structured `token_usage` log line includes the `max_tokens` sent with the request.

---

## v0.5.1 — August 2026

### Bug fixes

- **Fixed:** images returned by tool calls (e.g. `#browser/screenshotPage`) never reached the model — multimodal models such as Qwen3.7 Plus replied *"Unfortunately, I cannot view this image"*. Three separate defects were involved:
  - The provider never declared `capabilities.imageInput`, so VS Code treated every model as text-only and did not route image content to us at all. It is now declared per model.
  - `toOpenAIMessages()` mapped every non-text part of a tool result to `''`, dropping image data on the floor. Images in a tool result are now forwarded in a follow-up `user` message (the OpenAI schema only accepts a plain string in a `tool` message, so they cannot be sent inline), with the `tool` message carrying a short placeholder so the turn is never empty.
  - Message-level images were discarded whenever the same message also carried tool calls or tool results.
- **Fixed:** the 400-error classifier reported "This model does not support image input" for unrelated failures. Matching bare `unsupported` / `does not support` / `invalid content type` meant errors like *"unsupported parameter: max_tokens"* or *"does not support tool_choice"* were surfaced as vision errors, making capable models look text-only. The check now requires that we actually sent an image **and** that the server's message names an image-ish concept in a rejecting phrase; everything else is reported verbatim.
- **Fixed:** non-image data parts in tool results (`text/*`, `application/json`) were dropped instead of being decoded into the tool message — MCP tools returning JSON blobs lost their payload.
- Data parts are now also recognised structurally, so tool results crossing an extension-host realm boundary (where `instanceof` fails) are handled like native ones.

### Changes

- `customLlm.models` entries accept an optional `imageInput` flag. It is set automatically when the endpoint reports vision support (LiteLLM `/model/info` → `supports_vision`) and preserved across model refreshes; models without the flag are assumed to be vision-capable. Set `"imageInput": false` on a text-only model to stop VS Code sending it images.
- Request log lines now record whether a request carried images.

---

## v0.5.0 — July 2026

### Security

- **API keys are no longer stored in `settings.json`.** They now live in VS Code's encrypted `SecretStorage` (`ExtensionContext.secrets`), backed by the OS credential store. Fixes [#4](https://github.com/milhaus123/vscode-custom-llm-provider/issues/4).
  - Keys are filed under the provider's stable `id` slug, so renaming a provider or changing its endpoint keeps the key attached.
  - On startup, any `apiKey` still present in `customLlm.providers` is moved into secret storage and stripped from the setting — across user, workspace **and** folder settings, so a key in a committed `.vscode/settings.json` is cleaned up too. A one-time notification reports how many keys were moved.
  - The same sweep runs whenever `customLlm.providers` changes, so a hand-edited key does not linger in the file.
  - Writes to `customLlm.providers` now strip `apiKey` unconditionally — the extension can no longer put a key back into settings.
  - The legacy `customLlm.apiKey` / `customLlm.baseUrl` settings are cleared from every scope that defines them, not just user settings.
  - `apiKey` is marked deprecated in the settings schema and removed from the required-fields list.

> **Note:** a key that was previously committed to a repository should be rotated at the provider. Migration removes it locally but cannot un-publish it.

### Changes

- **Custom LLM: Manage providers** and **Test connection** now show `API key set (secure storage)`; clearing the input in *Edit API key* deletes the stored key, and removing a provider deletes its key as well.
- Keys are not carried by Settings Sync any more (secret storage is per-machine) — set them once per machine.

---

## v0.4.8 — May 2026

### Bug fixes

- **Fixed:** Clicking "Add Models" → "Custom LLM" in the Copilot model picker showed no input fields (name / URL / API key dialogs never appeared).
  - Root cause: VS Code 1.104+ keeps the model-picker webview panel in focus when it calls the `managementCommand`. Any `showInputBox` opened synchronously inside that handler was immediately dismissed by the webview stealing focus, causing `cmdAddProvider` to silently exit before the user could type anything.
  - Fix: added a 200 ms settle-time at the start of `cmdAddProvider` so the picker panel fully closes before the first native input dialog opens.

---

## v0.4.7 — May 2026

### Bug fixes

- **Fixed:** Custom models (e.g. `qwen35-397`) could not be invoked from Copilot Chat — Copilot looped on auxiliary `gpt-4o-mini` (`.copilotmd`) requests and the user's actual chat turn never reached our provider.
  - Root cause: previous versions wrote our model IDs into `github.copilot.chat.customOAIModels` (Copilot's BYOK settings) **in addition** to registering them through our `LanguageModelChatProvider`. When Copilot saw the same model ID in both places it sometimes routed via the BYOK path, didn't find an API key in Copilot's own secret storage, failed silently, and kept retrying the auxiliary model selection logic in a loop.
  - Removed the `syncCopilotPickerModels` write entirely — the chat provider already publishes its models to the picker via `provideLanguageModelChatInformation` + `showInModelPicker: true`, no second registration is needed.
  - On startup the extension now also **cleans up** any stale entries that earlier versions left in `customOAIModels` (foreign BYOK entries are preserved).

---

## v0.4.5 — April 2026

### Bug fixes

- **Fixed:** Original GitHub Copilot models (GPT-4, Claude, etc.) appeared to lose the user's prompt and reply with "what do you need?" while context climbed to ~95%, in a loop.
  - Root cause: the `@qwen` chat participant was declared `isSticky: true`, so once invoked it kept hijacking every subsequent turn even after the user switched models in the picker. In agent mode, where the actual content lives in references/tool calls rather than `request.prompt`, the participant forwarded an empty user message → the model asked for input → Copilot resent the (still empty) prompt → infinite loop.
  - Now `isSticky: false` — `@qwen` only routes the turn it explicitly appears in.
  - The participant also bails out with a clear warning instead of forwarding an empty `User('')` message.
- **Fixed:** `syncCopilotPickerModels()` was overwriting the entire `github.copilot.chat.customOAIModels` setting on every config change, wiping any BYOK models the user (or another extension) had configured. The function now **merges** instead — only entries owned by Custom LLM Provider are touched.
- **Fixed:** Write-amplification in the configuration watcher — `discoverAllModels` writes to `customLlm.models`, which fired the watcher, which called `syncCopilotPickerModels` again on every cycle. The watcher now reacts only to `customLlm.providers` and `customLlm.models`, and skips the redundant picker sync.

---

## v0.4.4 — April 2026

### Bug fixes
- **Fixed:** API key field was not visible in Settings UI when adding a new provider
  - Added `required` attribute to provider schema to ensure all fields (name, baseUrl, apiKey) are displayed in the VS Code Settings editor

---

## v0.4.3 — April 2026

### New features
- **Image/vision support** — attach images directly in Copilot Chat
  - The image attachment button is now enabled for all models — VS Code no longer shows images as crossed out
  - Images are converted to base64 `data:image/...` URLs and sent in the standard OpenAI multipart content format
  - If the selected model does not support images, a clear error message is shown: `"This model does not support image input. Use a multimodal model (e.g. qwen-vl-max)..."`
  - Non-image data parts (JSON, binary) are silently ignored

### Improved error messages
- API error responses are now parsed as JSON — users see the human-readable message instead of a raw JSON blob
- 400 errors mentioning "image", "vision", or "unsupported" show a specific helpful message with a suggestion to use a multimodal model
- 401 error message updated to reference the new `Custom LLM: Manage providers` command

---

## v0.4.2 — April 2026

_(superseded by v0.4.3 — do not use)_

---

## v0.4.1 — April 2026

### Bug fixes
- **Fixed:** Adding a second provider via the wizard (`Custom LLM: Add provider`) did not load the new provider's models or update the model picker
- **Fixed:** Adding a provider directly in `settings.json` did not trigger model discovery — models were never fetched for the new provider
- The config watcher now calls `GET /v1/models` when `customLlm.providers` changes (e.g. manual settings edit), preventing a discovery loop when only the model list changes
- `Custom LLM: Add provider` now explicitly notifies VS Code that the model list has changed after discovery completes

---

## v0.4.0 — April 2026

### Multi-provider support
- **New:** Add unlimited providers — each with its own Base URL and API key
- **New command:** `Custom LLM: Add provider` — guided wizard (name → URL → API key → auto-discover models)
- **New command:** `Custom LLM: Manage providers` — list, edit, or remove configured providers
- Each model is now tagged with its `providerUrl` so requests always go to the correct endpoint
- `provider.ts` routes each request to the right API key based on the model selected

### Dynamic model discovery
- On startup the extension calls `GET /v1/models` for every configured provider
- Models from all providers are merged into a single list in the Copilot Chat picker
- **New command:** `Custom LLM: Refresh model list from API` — manually reload at any time
- Falls back to built-in defaults when the endpoint is unreachable or no key is set

### Automatic migration
- Existing `customLlm.baseUrl` + `customLlm.apiKey` settings are migrated to the new `customLlm.providers` array automatically on first start — no manual action needed

### Settings changes
- **New:** `customLlm.providers` — array of `{ name, baseUrl, apiKey }`
- **Deprecated:** `customLlm.baseUrl` and `customLlm.apiKey` (still read for migration)

---

## v0.3.0 — April 2026

### Dynamic model discovery
- Extension fetches available models from `GET /v1/models` on startup
- Falls back to hardcoded defaults if the endpoint is unavailable

### Auto-migration of token limits
- On update, existing model settings are automatically updated with corrected context sizes

### Correct context window sizes
- `qwen3.6-plus`: 1M context, 65K output
- `qwen3.5-plus`: 1M context, 16K output
- `kimi-k2.5`: 256K context, 32K output
- `glm-5`: 200K context, 16K output
- `MiniMax-M2.5`: 256K context

### Better 401 error message
- When API key is invalid or missing, the error now shows a clear instruction to run `Custom LLM: Configure endpoint & API key`

---

## v0.2.0 — April 2026

### New models
All models from Alibaba Cloud Coding Plan added out of the box:
- `qwen3.6-plus` (1M context)
- `glm-5`, `glm-4.7` (Zhipu)
- `kimi-k2.5` (Moonshot)
- `MiniMax-M2.5` (MiniMax)

### Auto-merge of new models
- When updating the extension, any new default models are automatically added to the user's model list without overwriting custom entries

---

## v0.1.0 — March 2026

### `@qwen` chat participant
- Type `@qwen` in Copilot Chat to always route to your custom model
- Supports model selection by name: `@qwen qwen3-coder-plus refactor this`

### Tool calling & agent mode
- Full tool calling support: agent mode, `/fix`, `/edit`, `@workspace` all work

### Retry logic
- Automatic exponential backoff on 429 (rate limit) and 5xx (server errors)
- 3 retries with delays of ~1s, ~2s, ~4s (max 10s), with ±30% jitter
- Cancellation is never retried

### Initial model list
- `qwen3-coder-plus`, `qwen3-coder-next`, `qwen3-max`, `qwen3.5-plus`

---

## v0.0.1 — March 2026

- Initial release
- Basic OpenAI-compatible provider registered in VS Code Copilot Chat
- Model picker integration via `registerLanguageModelChatProvider`
