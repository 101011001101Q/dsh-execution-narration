# Machine translation of execution narration

Translates the agent's **English progress narration** (working notes, plans, interim summaries) into Simplified Chinese in place — at the original position, with no extra chat messages and no change to the agent's behaviour.

> ⚠️ **Privacy**: text to be translated is sent to a third-party translation service (Bing free anonymous endpoint by default; Google optional) and **may contain project code, file contents, or other private information**. Enabling acknowledges this.

## What it translates

| Translated | Left as-is |
|---|---|
| English working notes, plans and interim summaries produced while the agent works | Final answer, Reasoning content (handled by the official thinking-translation plugin) |
| Natural-language notes around file reads / code analysis / architecture research | User messages, tool-call records, run status, system prompts |
| Complete English paragraphs | File paths, commands, code blocks, technical identifiers |
| | Text already in Chinese |

**Scope is not decided by English phrasing**: in DSH, narration and the final answer are the same `text` block with no distinct event type. The plugin uses the render-time structural signal `turnProcess.spec.answerStep` to exclude the final answer; when that signal is unavailable it **never silently widens scope**, and offers only a per-step manual "Translate this step" entry.

## Interaction

- Automatic Simplified Chinese by default; the translation replaces the original text, preserving font, Markdown, code blocks and layout.
- "View original / View translation" toggle at any time; toggling never re-requests the translation.
- The original stays visible while loading; on failure/timeout the English original is shown with a "Retry" entry.
- With automatic translation disabled, a single step can still be translated manually.

## Settings

- Enable / disable automatic translation
- Service: Bing (default, free anonymous, no API key) / Google
- Target language: zh (default) / auto (follow UI language)
- Restore defaults, test translation

## Implementation & performance

- Reuses the official `ctx.translator` service; no duplicate translation engine, no large dependencies.
- Pure declarative React: wraps the built-in `assistant-step` renderer in place, keeping the official CoT plugin's `reasoning.body` chain — **both plugins can run together**.
- Incremental translation: split by blank lines / 4000 chars, translate only stable complete segments, show unfinished text as original.
- Exact-text-key cache + single-flight dedup + concurrency cap 3 + 120ms debounce + 15s timeout + AbortController cancel + failure fallback and retry.
- Code blocks, inline code, URLs and file paths are placeholder-protected; a missing placeholder makes the whole segment fall back to the original.
- Does not modify Session messages, model context, tool parameters or execution results.
- Translations are persisted to the local session file: the plugin passes the session id to the host translator, which therefore writes each source paragraph and its translation as `plugin:translator/request` / `plugin:translator/result` records into your own session file (this is what makes a reopened Session reuse translations instead of re-requesting them). They are plugin records, not edits to your messages, but the text lands on your local disk in clear text.

## Known limitations

1. `answerStep` is a render-time, non-persisted signal that depends on host presentation policy; it can be `null` during streaming or when there is no final answer, in which case the plugin conservatively skips translation.
2. Replacing the `assistant-step` renderer in place is incompatible with another plugin that replaces the same built-in entry (the official CoT plugin does not, so there is no conflict).
3. A DSH upgrade that changes the built-in renderer's props shape may require a matching update.
4. Bing / Google anonymous endpoint availability and output quality are outside this plugin's control.
