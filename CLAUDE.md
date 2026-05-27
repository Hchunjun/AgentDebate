# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentDebate is a Chrome MV3 browser extension that orchestrates AI debate across multiple logged-in AI web apps (ChatGPT, Kimi, DeepSeek, 豆包). The user provides a debate topic, and AgentDebate dispatches prompts to the chosen AI agents in sequence, collecting and displaying their responses as a structured debate transcript.

## Development

No build step, no bundler, no tests, no lint. Load the project directory directly as an unpacked extension in `chrome://extensions` with developer mode enabled. All source is plain JavaScript.

- **manifest.json** — MV3 manifest, declares permissions, content scripts, and side panel
- **src/background.js** — Service worker (opens side panel on toolbar click)
- **src/content/agentAdapter.js** — Content script injected into AI sites; handles DOM interaction (input, submit, extract response)
- **src/sidepanel/sidepanel.js** — Side panel UI + debate orchestration logic

## Architecture

The extension has three layers communicating via Chrome messaging (`source: "agentdebate"`):

```
sidepanel.js (UI + debate flow)
  → chrome.tabs.sendMessage → agentAdapter.js (content script on AI tab)
  → manipulates DOM on chatgpt.com / kimi.com / chat.deepseek.com / doubao.com
```

### Message protocol

All messages between sidepanel and content script carry `{ source: "agentdebate", type: "..." }`. The content script handles three message types:

- `GET_AGENTDEBATE_SITE_STATUS` — check if the tab is a recognized AI site
- `AGENTDEBATE_SEND_PROMPT` — inject a prompt, wait for response, extract answer
- `AGENTDEBATE_EXTRACT_LATEST_ANSWER` — read the latest assistant answer without sending

### Debate flow

`runDebate(topic)` in sidepanel.js iterates through the active debate flow from `src/debateFlowConfig.js` (default: 裁判 → 正方 → 反方; alternate: 正方 → 反方 → 裁判). Each flow owns its role order, default agent assignments, and role prompts. When multiple flows exist, the side panel shows a flow selector and persists role assignments per flow. For each role, sidepanel looks up the assigned agent, finds an open tab for that agent via `findProviderTab`, sends the configured role prompt plus context via the content script, waits for the answer to stabilize, then appends to the transcript.

### Provider adaptation (agentAdapter.js)

Each AI provider has a `PROVIDERS` entry defining:
- `searchHandler.steps` — ordered DOM actions (focus, setValue, triggerEvents, click, sendKeys, wait) to input and submit a prompt
- `contentExtractor` — CSS selectors for finding the latest assistant response
- `stableMs` — how long the answer must stay unchanged before it's considered complete

The content script auto-injects when declared in manifest's `content_scripts`, but sidepanel can also manually inject via `chrome.scripting.executeScript` if the content script wasn't loaded yet.

### State

Debate state (messages + role assignments) is persisted to `chrome.storage.local` (with a localStorage fallback for non-extension environments).

## Key conventions

- UI language and all user-facing strings are in Chinese
- Agent IDs: `gpt`, `kimi`, `deepseek`, `doubao`
- Role IDs: `affirmative`, `negative`, `judge`
- DOM selectors for AI sites may break when providers update their UI — these are the most fragile parts of the codebase
