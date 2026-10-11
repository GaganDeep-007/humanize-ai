# humanize-ai

AI-content / plagiarism scoring and humanization, with a Telegram bot and LM Studio / OpenRouter / free-provider routing.

Humanizes AI text in the style of [cleverhumanizer.ai](https://cleverhumanizer.ai) — **refinement, not rewriting** — then gates the result through an AI detector and re-polishes until it reads as written by a human.

## Features

- **Clever-style rewriting engine** — find repetitive phrasing, rework flat tone, lock the meaning, self-review; no sledgehammer rewrites.
- **Two styles** — `normal` (simple, conversational) and `clear-structured` (tidy, professional, keeps outlines/headings).
- **Strict AI-detector gate** — a pluggable detector with an ordered fallback chain (`huggingface → sapling → gptzero → contentdetector → kiprio → wasitai`) that degrades to the *keyless* contentdetector, so it keeps working with zero API keys. Every failed attempt feeds concrete feedback back into the next rewrite.
- **Adaptive detector weighting** — decisive detector scores (0% or 100%) get weight up to 0.8; ambiguous scores (~50%) keep the configured base blend, so clean prose passes a strict 5% bar while pattern-heavy text still fails.
- **Decision engine** — gate-before-rewrite (`gateOriginal`), strategy ladder with feedback, budget of N attempts and a wall clock; falls back to the legacy humanizer if disabled.
- **Telegram bot** — drop a file or text, get a scored + humanized `.docx` back; `/style`, `/decide`, `/why`, `/roster`, `/budget`, `/detector`, `/providers`.
- **Zero/low cost** — OpenRouter `:free` models, optional local LM Studio on your LAN, optional free LLM providers (groq, gemini, cerebras, mistral), no external databases.

## Architecture

```
              ┌─────────────┐
   CLI / bot ──▶   decision  │ runUntilPass: gate → humanize → refine → voice-polish
              │   engine    │   (feedback loop until detector/combined ≤ aiThreshold)
              └──────┬──────┘
                     ▼
              ┌─────────────┐        ┌──────────────────────┐
              │  humanizer  │──────▶ │ provider routing      │  lmstudio-first →
              │ (prompts)   │        │ (openrouter/free,     │  openrouter/free,
              └──────┬──────┘        │  groq/gemini/… )      │  free providers
                     ▼               └──────────────────────┘
              ┌─────────────┐
              │  analyzer   │  robustAnalyze: heuristic + detector (adaptive weight) + Laya optional
              └─────────────┘
```

- `lib/heuristics.js` — heuristic AI / plagiarism scorer (length-normalized).
- `lib/detector.js` — pluggable detector chain; each provider normalised to a 0–100 AI score.
- `lib/analyzer.js` — combined score, adaptive detector weight, windowed eval.
- `lib/humanizer.js` — prompt templates (humanize / refine / voice-polish) + style blocks.
- `lib/decision.js` — gate / strategy registry / feedback loop.
- `lib/brain.js` — lightweight LLM judge for hallucination checks + model memory.
- `lib/laya.js` — optional Laya (System-1 typed decision) integration (disabled by default).
- `bot/index.js` — Telegram bot (text, docx, pdf, pptx) with cleanup of `storage/`.

## Getting started

Requires Node >= 18.

```bash
npm install
humanize-ai login            # reads ~/.ori/credentials.json or OPENROUTER_API_KEY
humanize-ai config --ai-threshold 5   # strict bar (default is 25)
humanize-ai config --style normal | clear-structured
```

### Telegram bot

```bash
humanize-ai bot-setup --token <TOKEN> --id <your-user-id>   # from BotFather
systemctl --user enable --now humanize-bot.service          # or: humanize-ai bot
```

## CLI usage

```bash
humanize-ai analyze  file.txt            # score original text (AI% , plagiarism%)
humanize-ai humanize file.txt [-o out.docx] [--format docx|txt] [--style normal|clear-structured]
humanize-ai report   file.txt            # humanize + print before/after
humanize-ai providers / detector         # key status, detector health
```

## Detector setup (optional — works with zero keys)

```bash
humanize-ai detector                  # status: current provider, chain, fallback
humanize-ai detector --set <KEY>      # key for the current provider
humanize-ai detector --provider sapling|huggingface|contentdetector|kiprio|wasitai|gptzero
```

Default config has no keys and walks `contentdetector → kiprio` (both free). Add an
`hfToken` for the best free long-lived option. The combined score blends heuristic and
detector; with `fallback: true` an expired or absent key silently moves to the next provider.

## Development

```bash
npm test        # offline suites: adaptive weight, clever-style prompts, detector chain, length-invariance
node --check lib/*.js bin/humanize-ai bot/*.js scripts/*.js tests/*.js
```

Design notes and operating history live in the workspace-level `SESSION-CONTEXT.md`.

## License

[MIT](LICENSE) — Copyright (c) 2026 gd.