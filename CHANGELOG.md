# Changelog

## v0.3.0 — April 2026

### Added `@qwen` chat participant
- **New feature:** `@qwen` participant for direct routing of queries to custom LLM
- **Better UX:** No need to change model picker — just type `@qwen` in chat
- **Model support:** Automatic model selection based on first word in prompt

### Tool calling (agent mode)
- **`toolCalling: true`** — agent mode, `/fix`, `/edit`, `@workspace` now work
- Models can call VS Code tools (file reading, editing, running commands)

### Updated models
- Added `qwen3.6-plus` (1M context, 64K output)
- Added `glm-5` (200K context)
- Added `MiniMax-M2.5` (256K context)
- Updated token limits for all models

### VS Code 1.104+
- Minimum required version bumped to `^1.104.0`

---

## v0.2.0

### Retry logic fix
- Fixed exponential backoff implementation
- Better error handling and edge cases

### Code cleanup
- Removed unnecessary files and dependencies

---

## v0.1.0

### 🎯 Main Changes

#### Removed chat participant (@qwen)
- **Reason:** `mgt.clearMarks is not a function` error and duplicate functionality
- **Solution:** Extension now uses only the standard model picker in Copilot Chat
- **Benefits:**
  - Cleaner architecture
  - No more markdown renderer errors
  - Consistent UX with other Copilot extensions

#### Added retry logic for network requests
- **Exponential backoff:** 1s → 2s → 4s between attempts
- **Retries on:**
  - 429 Too Many Requests (rate limit)
  - 500-504 Server errors
- **Maximum delay:** 10 seconds
- **Random jitter:** ±30% to prevent thundering herd
- **Cancellation respected:** No retry when user presses "stop"

#### Tool Calling support (preparation)
- Added OpenAI function calling types
- Implemented tool_calls parsing in stream handler
- Currently set to `toolCalling: false`
- Ready for future VS Code tool integration

### 📦 Technical Changes

#### Updated dependencies
```json
"engines": {
  "vscode": "^1.94.0"     // was: ^1.90.0
},
"devDependencies": {
  "@types/vscode": "^1.94.0"  // was: ^1.90.0
}
```

#### Removed files
- `src/participant.ts` - no longer needed
- `out/participant.js` - compiled version
- `out/participant.js.map` - source map

#### Updated files
- `src/extension.ts` - removed participant reference
- `src/provider.ts` - added retry logic and tool calling types
- `package.json` - removed chatParticipants from contributes
- `README.md` - updated documentation
- `tsconfig.json` - added better compiler options
- `.vscodeignore` - ignore unnecessary files

### New files
- `LICENSE.md` - MIT license (required for publishing)
- `CHANGELOG.md` - this file

## 🐛 Bug Fixes

### v0.0.x
- `mgt.clearMarks is not a function` - removed participant
- Inconsistent base URL between provider and participant
- Missing retry logic for production use

### v0.1.0
- All known issues resolved

## 🚀 How to Update

```bash
# Uninstall old version
code --uninstall-extension MartinRiha.vscode-custom-llm-provider

# Install new version
code --install-extension vscode-custom-llm-provider-0.1.0.vsix
```

## 📝 Migration Notes

If you were using the `@qwen` command in Copilot Chat:
1. Open Copilot Chat (`Ctrl+Alt+I`)
2. Click the model name at the top of the chat
3. Select any Qwen model from the list
4. You can now chat directly with the selected model

## 🔮 Planned Features (Future Versions)

- [ ] Full tool calling support for VS Code functions
- [ ] Custom tokenizer for more accurate token counting
- [ ] System messages support
- [ ] Configurable retry policy in settings
- [ ] Metrics and telemetry for error monitoring

---

**Released versions:**
- v0.1.0 (2026-03-31) - Major refactor, retry logic, tool calling preparation
- v0.0.1 (2026-XX-XX) - Initial release
