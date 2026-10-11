# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-10-11

### Added
- Clever.ai-style rewriting engine: refinement-first prompts with meaning lock and a self-review pass (replaces the old sledgehammer rewrite).
- Style selector — `normal` and `clear-structured` — via `humanize-ai config --style`, `humanize-ai humanize --style`, and the bot's `/style` command.
- Pluggable AI detector with an ordered zero-key fallback chain (ends at the keyless contentdetector) so expired/absent keys never degrade the pipeline to nothing.
- Adaptive detector weighting: decisive detector scores (0%/100%) command up to 0.8 weight, ambiguous (~50%) keep the configured 0.3 base — clean prose now passes a strict 5% bar.
- Detector-grounded self-review loop: each failed gate returns concrete findings (top phrases, rhythm CV, repetitive starts, detector notes) that steer the next rewrite.
- Offline regression suites + `npm test` (adaptive weight, clever-style prompts, detector chain, length-invariance).

### Changed
- Legacy rewrite Pass 3 is now a voice-polish pass with real score feedback (temperature 0.95 → 0.85).
- Strategy registry renamed `aggressive` → `polish` (old memory keys are inert, not removed).
- CLI help default model corrected to `openrouter/free`.

### Removed
- Dead code: unused `VERIFY_PROMPT`, unused `displayModel`, unused `brainAvailable` import.
- Hardcoded Telegram bot token from `laya-service/colab/laya-colab.py` (now read from env).

### Security
- A live Telegram bot token that had been committed in source is removed; rotate it with BotFather if it was ever shared.

## [1.0.0] - 2026-09-10

Initial working release — CLI + Telegram bot for AI-content / plagiarism scoring and humanization over LM Studio / OpenRouter / free providers.