# Execution Narration Translation (执行过程叙述机器翻译)

A DSH plugin that translates an agent's English **execution narration** into Simplified Chinese **in place** — the progress notes an agent writes while it works, such as the sentence before it reads a file or inspects a directory.

The official `思考过程和翻译` (reasoning translation) plugin only covers **Reasoning** content. It does not touch the ordinary narration an agent writes between tool calls. This plugin covers that gap, and the two run side by side.

> ⚠️ **Privacy.** Text to be translated is sent to a third-party translation service (Microsoft Bing's free anonymous endpoint by default). It **may contain project code, file contents, or other private information**. Turn automatic translation off in the plugin's settings if that is not acceptable for a session.

## What it translates

| Translated | Left alone |
|---|---|
| The agent's English progress narration, plans and phase summaries | The final answer |
| Natural-language notes before and after reading files, analysing code or researching architecture | Reasoning content (the official plugin's job) |
| Complete English paragraphs | User messages, tool records, run status, system prompts |
| | File paths, commands, code blocks, technical identifiers |
| | Anything already in Chinese |

**The scope test is structural, not stylistic.** In DSH, narration and the final answer are the *same* `text` block inside the *same* `assistant-step` node — there is no separate event type or part type to tell them apart. The plugin therefore uses the render-time signal `turnProcess.spec.answerStep` to exclude the final answer:

- `data.step === answerStep` → final answer, never auto-translated;
- `data.status === 'running'` → still generating, and possibly the final answer, so not auto-translated;
- `groupPart === 'reasoning'` → the reasoning group, which belongs to the official plugin;
- `turnProcess.spec == null` → no structural signal available, so nothing is auto-translated and only a per-step manual entry is offered.

A manual **"Translate this step"** entry is available on every step, including the final answer and streaming ones, so the user can always choose explicitly. The plugin never silently widens its own scope.

## Interaction

- Translation replaces the original text in place. No extra chat message, no bordered card, no separate window; the existing font size, spacing, Markdown and layout are preserved.
- **View original / View translation** toggles back and forth without re-requesting the translation service.
- The original stays visible while a translation is in flight, so nothing flickers.
- On failure or timeout the English stays and a **Retry** entry appears; the agent's execution is never affected.
- Turning automatic translation off still leaves the per-step manual entry available.

## Settings

Available on the plugin's detail page:

- Enable / disable automatic translation
- Translation service: Bing (default, free, no API key) or Google
- Target language: `zh` (default) or `auto` (follow the UI language)
- Restore defaults, and translate one sample sentence to check connectivity

Settings persist through DSH's `configEditor`.

## How it works

- **Reuses the official `ctx.translator` service** instead of shipping another engine. That service is mounted by the built-in `dsh-experimental-cot-translation-bundle`; this plugin does not insert a duplicate row and only looks it up at runtime with `ctx.get('translator')`. If the service is absent, the plugin degrades to showing originals.
- **Pure declarative React, no DOM scanning.** `conversation.chat.node` is a keyed slot, but registering a second `assistant-step` entry cannot work: the built-in entry has already declared the child slots `conversation.chat.reasoning.body` and `conversation.chat.message.images`, and a second entry declaring the same children throws, while an entry without children never receives a usable `renderSlot`. The plugin instead **wraps the built-in renderer in place**: it finds the `assistant-step` entry, keeps its component, and swaps in a wrapper that replaces only `text` block content before delegating with `React.createElement(Original, props)`. The built-in children, injections and `renderSlot` bindings all survive, which is what keeps the official reasoning-translation plugin working.
- **Streaming and performance**: text is split on blank lines (and hard-split at the service's `maxTextChars`), and only complete paragraphs are sent. The engine keeps an exact-text cache, single-flights duplicate requests, debounces at 120 ms, caps concurrency at 3, times out at 15 s, aborts on unmount or session switch, and falls back to the original on failure.
- **Code protection**: fenced code, inline code, URLs, file paths and `@scope/pkg` names are replaced with ASCII placeholders before the request. If any placeholder is missing from the response, the whole paragraph falls back to the original, so Markdown, code and paths are never mangled.
- **Nothing is mutated upstream**: no session message, model context, tool argument or execution result is changed.

## Install

```sh
dsh plugin --profile <profile> add dsh-execution-narration
```

Or install it from a local checkout with the plugin manager's `install_bundle`, pointing at this directory. Restart DSH so the Host half loads; the browser half hot-reloads.

Manage it afterwards from **Plugins → Installed → Execution Narration Translation**.

## Known limitations

1. `answerStep` is a render-time signal and is not persisted; it depends on the host's presentation policy. During streaming, or when a turn has no final answer, it can be `null` — the plugin then conservatively translates nothing automatically.
2. The plugin replaces the built-in `assistant-step` renderer in place. It therefore conflicts with **another** plugin that replaces the same built-in entry; the official reasoning-translation plugin does not touch it.
3. A DSH upgrade that changes the built-in renderer's props (`node.data.blocks`, `turnProcess`, `groupPart`, …) may require a matching update here.
4. The availability, rate limits and output quality of the anonymous Bing / Google endpoints are outside this plugin's control.
5. The Google anonymous endpoint was observed timing out from some networks while Bing worked; Bing is the default for that reason.

## License

MIT — see [LICENSE](LICENSE).
