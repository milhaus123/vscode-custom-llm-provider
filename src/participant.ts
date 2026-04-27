import * as vscode from 'vscode';

/**
 * Chat participant @qwen — routes all requests through our registered
 * LanguageModelChatProvider (custom-llm vendor), so VS Code handles the
 * streaming protocol correctly and the mgt.clearMarks error cannot occur.
 */
export function registerChatParticipant(context: vscode.ExtensionContext): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    'custom-llm.qwen',
    async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ) => {
      // Get models registered by our provider
      const models = await vscode.lm.selectChatModels({ vendor: 'custom-llm' });

      if (!models || models.length === 0) {
        stream.markdown(
          '⚠️ **No models available.**\n\n' +
          'Configure your endpoint first:\n' +
          '`Ctrl+Shift+P` → **Custom LLM: Configure endpoint & API key**'
        );
        return;
      }

      // Pick the model: if the first word of the prompt matches a known model id, use it.
      // Otherwise fall back to the first available model.
      let model = models[0];
      const firstWord = request.prompt.trim().split(/\s+/)[0];
      const byId = models.find(m => m.id === firstWord);
      if (byId) {
        model = byId;
      }

      const userPrompt = byId
        ? request.prompt.trim().slice(firstWord.length).trim()
        : request.prompt;

      // Bail out on empty prompts — happens in agent mode when actual content
      // is in references / tool results rather than `request.prompt`. Without
      // this guard we would send `User('')` to the model, which replies
      // "what do you need?" and Copilot retries → infinite loop, context
      // climbs to 95%. See FIXES.md for prior incident.
      const finalUserText = (userPrompt || request.prompt).trim();
      if (!finalUserText) {
        stream.markdown(
          '⚠️ **Empty prompt.** Type a message before sending — ' +
          '`@qwen` only sees plain text, not attached files or tool results from the picker.'
        );
        return;
      }

      // Build message history
      const messages: vscode.LanguageModelChatMessage[] = [];

      for (const turn of chatContext.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
          if (turn.prompt && turn.prompt.trim()) {
            messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
          }
        } else if (turn instanceof vscode.ChatResponseTurn) {
          const text = turn.response
            .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
            .map(p => p.value.value)
            .join('');
          if (text) {
            messages.push(vscode.LanguageModelChatMessage.Assistant(text));
          }
        }
      }

      messages.push(vscode.LanguageModelChatMessage.User(finalUserText));

      // Show which model is responding
      stream.markdown(`*[${model.name}]*\n\n`);

      try {
        // Use vscode.lm API — goes through CustomLlmProvider.provideLanguageModelChatResponse()
        // This is the correct path; direct HTTP calls caused the mgt.clearMarks error.
        const response = await model.sendRequest(messages, {}, token);

        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            stream.markdown(chunk.value);
          }
        }
      } catch (err) {
        if (err instanceof vscode.LanguageModelError) {
          stream.markdown(`\n\n❌ **${err.code}:** ${err.message}`);
        } else if (err instanceof Error && err.name !== 'AbortError') {
          stream.markdown(`\n\n❌ ${err.message}`);
        }
      }
    }
  );

  participant.iconPath = new vscode.ThemeIcon('sparkle');

  context.subscriptions.push(participant);
  return participant;
}
