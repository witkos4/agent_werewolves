# S-06 verification

Date: 2026-11-08. Status: in progress.

## Model smoke (Phase 1)

`npm run smoke:models` with a real OpenRouter key, 2026-11-08. Each model got one `discuss` and one `vote` request built by `buildRequest` (all five seats on that model, random personalities). Every reply passed `validateMove`.

| Model | discuss | vote | Cost (both) | Latency (discuss / vote) |
|---|---|---|---|---|
| google/gemini-3.1-flash-lite | ok | ok | $0.00047 | 1990 / 1130 ms |
| anthropic/claude-haiku-5.5 | ok | ok | $0.00024 | 1271 / 894 ms |
| openai/gpt-6-luna | ok | ok | $0.00016 | 1943 / 1429 ms |
| deepseek/deepseek-v4-flash | ok | ok | $0.00013 | 1237 / 810 ms |
| qwen/qwen3.8-flash | ok | ok | $0.00021 | 1641 / 4847 ms |
| mistralai/mistral-small-2603 | ok | ok | $0.00022 | 968 / 648 ms |

Total $0.00143, 0 failures.
