# README illustrations

The four PNG files in this directory are conceptual documentation illustrations for v0.6.0, generated with the built-in imagegen tool on 2026-09-09. They are not VS Code screenshots or evidence of a live endpoint test. The old SVG mockups have been retired; the prompt set below is the source brief for the replacements.

| Saved asset | What it explains |
| --- | --- |
| [alibaba-coding-plan.png](alibaba-coding-plan.png) | Endpoint → extension → VS Code Chat and credential storage |
| [settings.png](settings.png) | Command Palette setup and per-model configuration |
| [model-picker.png](model-picker.png) | The GLM-5.3 example profile and separate model registrations per provider |
| [qwen-participant.png](qwen-participant.png) | Ongoing model-picker use versus a single text-only participant turn |

All image content is also explained in the main README so it remains accessible without the graphics. The filenames are stable to preserve existing README image references.

## Maintenance

Before replacing a visual, verify behavior in [extension.ts](../src/extension.ts), [modelRegistry.ts](../src/modelRegistry.ts), [participant.ts](../src/participant.ts), and [secrets.ts](../src/secrets.ts). Update both the image and the corresponding README text. In particular:

- Provider and model management uses native QuickPick/InputBox flows. Do not illustrate a settings dashboard as if it exists.
- A stored API key is read for endpoint authentication. Do not claim it never leaves the machine.
- GLM-5.3's pictured capabilities are an example extension profile, not a live endpoint verification.
- The optional `@qwen` participant forwards plain-text prompts and text history. It does not forward attachments or run an agent tool loop.
- Keep the "Illustrated guide" label and readable text. Check every generated label, connector, and capability value before use.
- Rebuild the VSIX after updating the PNGs so the installation package includes the same images.

## Final prompt set

Generation used the built-in imagegen tool, one independent call per asset, with no reference-image input and no CLI fallback.

### alibaba-coding-plan.png

```text
Use case: infographic-diagram.
Asset type: one standalone landscape 16:9 technical README illustration for the open-source VS Code extension Custom LLM Provider, version 0.6.0. Prefer 1536x864 output.
Style: polished editorial software documentation, deep navy background (#101626), restrained blue and teal accents, off-white crisp sans-serif typography, flat vector-like diagram shapes with subtle depth. Generous whitespace, consistent thin connectors, simple line icons, strong readability at 800px display width. No photography, no robot, no generated code, no decorative fake browser or VS Code window chrome, no fictional app interface, no simulated chat response, no stock art, no watermark. This is a conceptual illustration, not a screenshot.
Layout: large clear title above the diagram, a small top eyebrow "CUSTOM LLM PROVIDER", a small bottom caption "Illustrated guide · v0.6.0". All requested literal text must be rendered verbatim, spelled correctly; do not add claims, labels, badges or tiny illegible filler text.
Primary request: a clear product architecture illustration explaining how users connect an OpenAI-compatible endpoint to VS Code Chat. 
Title (verbatim): "Your models in VS Code"
Subtitle (verbatim): "Connect a provider. Discover models. Start chatting."
Main diagram: three large evenly spaced cards arranged in a left-to-right sequence. Card 1 shows a cloud/server line icon, label "Your endpoint", and two subordinate lines "Alibaba Coding Plan" and "or another compatible API". Card 2 shows an abstract connector line icon, label "Custom LLM Provider", subordinate lines "Model discovery" and "Capabilities per model". Card 3 shows a code-window line icon without branded app chrome, label "VS Code Chat", subordinate lines "Model picker" and "Streaming responses". Connect card 1 to card 2 and card 2 to card 3 with clean bidirectional arrows.
Below the three-card row, a clearly separate full-width note with a small lock icon, text "API keys are stored in VS Code SecretStorage".
Avoid: model names or prices; do not imply an API key never leaves the computer when authenticating a request; do not invent provider logos.
```

### settings.png

```text
Use case: infographic-diagram.
Asset type: one standalone landscape 16:9 technical README illustration for the open-source VS Code extension Custom LLM Provider, version 0.6.0. Prefer 1536x864 output.
Style: polished editorial software documentation, deep navy background (#101626), restrained blue and teal accents, off-white crisp sans-serif typography, flat vector-like diagram shapes with subtle depth. Generous whitespace, consistent thin connectors, simple line icons, strong readability at 800px display width. No photography, no robot, no generated code, no decorative fake browser or VS Code window chrome, no fictional app interface, no simulated chat response, no stock art, no watermark. This is a conceptual illustration, not a screenshot.
Layout: large clear title above the diagram, a small top eyebrow "CUSTOM LLM PROVIDER", a small bottom caption "Illustrated guide · v0.6.0". All requested literal text must be rendered verbatim, spelled correctly; do not add claims, labels, badges or tiny illegible filler text.
Primary request: explanatory setup diagram, showing real command-based configuration flow without pretending to be the actual UI.
Title (verbatim): "Configure providers and models"
Subtitle (verbatim): "Start in the VS Code Command Palette"
Two equal-width vertical lanes below the title. Each lane has a subtle outlined frame, a small numbered circle at top (1 then 2), and an upper pill styled as a command label, not an interactive button.
Left command text (verbatim): "Custom LLM: Add provider".
Left lane sequence: "Provider name" then "Base URL" then "API key", each on its own clearly spaced row connected by a subtle vertical line. Below the sequence a lock icon and two lines "VS Code SecretStorage" and "Keys stay out of settings.json".
Right command text (verbatim): "Custom LLM: Manage models".
Right lane sequence: "Select provider and model" then three separate compact text rows "Image input · Tool calling", "Thinking effort · Output limit", and "Picker visibility". At the bottom two lines "Saved per model" and "Overrides survive refresh".
Avoid any sidebar, dashboard, toggle-switch panel, or fabricated settings UI. These are instructional diagram lanes, not screenshots.
```

### model-picker.png

```text
Use case: infographic-diagram.
Asset type: one standalone landscape 16:9 technical README illustration for the open-source VS Code extension Custom LLM Provider, version 0.6.0. Prefer 1536x864 output.
Style: polished editorial software documentation, deep navy background (#101626), restrained blue and teal accents, off-white crisp sans-serif typography, flat vector-like diagram shapes with subtle depth. Generous whitespace, consistent thin connectors, simple line icons, strong readability at 800px display width. No photography, no robot, no generated code, no decorative fake browser or VS Code window chrome, no fictional app interface, no simulated chat response, no stock art, no watermark. This is a conceptual illustration, not a screenshot.
Layout: large clear title above the diagram, a small top eyebrow "CUSTOM LLM PROVIDER", a small bottom caption "Illustrated guide · v0.6.0". All requested literal text must be rendered verbatim, spelled correctly; do not add claims, labels, badges or tiny illegible filler text.
Primary request: clear diagram explaining that a model's abilities are per-model and that the same model ID at two providers remains separate. No literal model-picker UI.
Title (verbatim): "Choose the right model"
Subtitle (verbatim): "Check the provider and model capabilities"
Main area has a large example capability card taking about two thirds of width, and a narrower supporting diagram alongside.
Main card eyebrow "EXAMPLE PROFILE", model name "zai-org/GLM-5.3". Four large aligned rows:
"Text input" with value "Enabled" and a teal check;
"Image input" with value "Disabled" and a neutral dash (no green check);
"Tool calling" with value "Enabled" and a teal check;
"Thinking effort" with value "low · high · max" with a blue reasoning icon.
Supporting diagram heading "Separate providers". Under it two separate cards labeled respectively "Provider A" and "Provider B"; each has the identical secondary label "Same model ID". There must be no arrow between these two cards. Under them a concise caption "Two separate choices".
A bottom note spanning the main area says "Unknown vision and tool support default to disabled."
Avoid implying GLM-5.3 accepts pictures, avoid presenting this as a live test result, avoid saying all known model families support all features.
```

### qwen-participant.png

```text
Use case: infographic-diagram.
Asset type: one standalone landscape 16:9 technical README illustration for the open-source VS Code extension Custom LLM Provider, version 0.6.0. Prefer 1536x864 output.
Style: polished editorial software documentation, deep navy background (#101626), restrained blue and teal accents, off-white crisp sans-serif typography, flat vector-like diagram shapes with subtle depth. Generous whitespace, consistent thin connectors, simple line icons, strong readability at 800px display width. No photography, no robot, no generated code, no decorative fake browser or VS Code window chrome, no fictional app interface, no simulated chat response, no stock art, no watermark. This is a conceptual illustration, not a screenshot.
Layout: large clear title above the diagram, a small top eyebrow "CUSTOM LLM PROVIDER", a small bottom caption "Illustrated guide · v0.6.0". All requested literal text must be rendered verbatim, spelled correctly; do not add claims, labels, badges or tiny illegible filler text.
Primary request: instructional routing diagram showing the optional @qwen participant is text-only and applies to just one message. No fictional assistant responses or app screenshots.
Title (verbatim): "Two ways to use your model"
Subtitle (verbatim): "Pick a model for ongoing work, or route one text message"
Two equal-width cards in the main area.
Left card heading "Model picker", code/chat line icon. Three readable lines beneath: "Select your custom model", "Continue chatting normally", "Tools and images when supported". Finish the card with a subtle label "For ongoing work".
Right card heading "@qwen", text-message line icon. Three readable lines beneath: "Prefix one message with @qwen", "Uses a custom model for that turn", "Plain-text prompts and history". Finish the card with a subtle label "Optional · one turn".
Beneath the cards, one long horizontal flow: a message label "Next message without @qwen" then a clean arrow then the destination label "Model selected in the picker".
Avoid an agent-active indicator for @qwen, avoid images or tool calls entering @qwen, avoid any simulated completed task or verified live model response.
```

