# omp-subrouter

Route [**omp** (oh-my-pi)](https://omp.sh) through a local [**manaflow-ai/subrouter**](https://github.com/manaflow-ai/subrouter) daemon.

Subrouter is a local proxy that pools multiple **Claude Max** / **ChatGPT Pro** subscriptions (and API keys) behind one endpoint, with sticky, rate-limit-aware account selection. This plugin registers that endpoint as native omp providers, so you can pick a pooled model straight from omp's model selector — no per-tool logins, no manual `models.yml` edits.

```
subrouter/claude-opus-4-8        → Claude Max pool   (Anthropic Messages API)
subrouter-codex/gpt-6-sol        → ChatGPT pool      (Codex Responses API)
```

## Requirements

- omp `>= 18`
- A running subrouter daemon with at least one account added.

## Install

### A. omp marketplace (recommended)

```
omp plugin marketplace add al3rez/omp-subrouter
omp plugin install subrouter@omp-subrouter
```

Then restart omp (extension modules load at session start). From inside a session you can also run `/marketplace add al3rez/omp-subrouter` and `/marketplace install subrouter@omp-subrouter`.

### B. One file, no marketplace

Drop the extension into your agent directory — omp auto-discovers `~/.omp/agent/extensions/*.ts`:

```bash
mkdir -p ~/.omp/agent/extensions
curl -fsSL https://raw.githubusercontent.com/al3rez/omp-subrouter/main/plugins/subrouter/extension/subrouter.ts \
  -o ~/.omp/agent/extensions/subrouter.ts
```

On Windows (PowerShell):

```powershell
mkdir "$env:USERPROFILE\.omp\agent\extensions" -Force
curl -fsSL https://raw.githubusercontent.com/al3rez/omp-subrouter/main/plugins/subrouter/extension/subrouter.ts `
  -o "$env:USERPROFILE\.omp\agent\extensions\subrouter.ts"
```

> Use **either** A or B, not both — two copies would register the same providers twice.

## Set up subrouter

```bash
npm i -g subrouter            # or: pipx install subrouter
subrouter serve --addr 127.0.0.1:31415   # keep this running
sr add claude work            # add a Claude Max subscription (repeat as needed)
sr add                        # add a Codex / ChatGPT account (optional)
sr status                     # verify the pool
```

macOS/Linux users can install subrouter as a background service instead
(`sr install-daemon` / `sr install-systemd`); on Windows run `subrouter serve`
yourself (a scheduled task or a terminal tab works).

## Use

```bash
omp --model subrouter/claude-opus-4-8
# or pick any subrouter/… model from the selector
```

Registered models:

| Provider          | Models                                                                    | Wire API                 |
| ----------------- | ------------------------------------------------------------------------- | ------------------------ |
| `subrouter`       | `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-sonnet-4-5`, `claude-haiku-4-5` | `anthropic-messages`     |
| `subrouter-codex` | `gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.5` | `openai-codex-responses` |

Pricing is inherited from omp's built-in catalog (each model omits an explicit
`cost`, so the matching catalog card is used).

## Configuration

| Env var          | Default                  | Purpose                                  |
| ---------------- | ------------------------ | ---------------------------------------- |
| `SUBROUTER_URL`   | `http://127.0.0.1:31415` | Subrouter daemon root (local or remote). |
| `SUBROUTER_TOKEN` | auto-detected            | Bearer token for the local hop. Only needed to override detection. |

A trailing `/` or `/v1` on `SUBROUTER_URL` is tolerated.

## How it works

The extension calls omp's `pi.registerProvider()` for two dedicated providers
(it does **not** hijack your built-in `anthropic` / `openai`):

- **Claude pool** → `POST {SUBROUTER_URL}/v1/messages`, header `X-Subrouter-Agent: claude`.
- **Codex pool** → `POST {SUBROUTER_URL}/backend-api/codex/responses`, header `X-Subrouter-Agent: codex` (this is subrouter's `chatgpt_base_url` surface).

The local hop authenticates with the non-secret placeholder token `subrouter`
(sent as `Authorization: Bearer subrouter`); subrouter swaps in the real pooled
account before forwarding upstream.

A daemon started with `--cloud-config` is different: it rejects every request
that does not carry that config's `localProxyToken`, so the placeholder gets a
bare `401 unauthorized`. The extension therefore resolves the token as:

1. `SUBROUTER_TOKEN`, when set
2. `localProxyToken` from `~/.config/subrouter/cloud.json`, when that file exists
3. the `subrouter` placeholder

The token is read at session start and never written anywhere.

If the daemon is unreachable, omp logs a one-line hint at startup and only the
`subrouter/*` models fail — your other providers are untouched.

## Troubleshooting

- **`subrouter/*` models error / connection refused** — the daemon isn't
  running. Start `subrouter serve --addr 127.0.0.1:31415` and check
  `curl http://127.0.0.1:31415/_subrouter/health`.
- **`subrouter/*` models return 401 `unauthorized`** — the daemon is running
  with `--cloud-config` and wants its `localProxyToken`. That is picked up from
  `~/.config/subrouter/cloud.json` automatically; set `SUBROUTER_TOKEN`
  explicitly if your config lives elsewhere.
- **`subrouter-codex/*` returns `400 ... model is not supported when using
  Codex with a ChatGPT account`** — the ChatGPT backend gates model
  availability on the `version` header (the Codex client version). omp 18.2.8
  sends `version: 0.153.0` and its codex transport overwrites any provider
  header, so no model id in the table currently resolves. The identical request
  with `version: 0.156.1` returns 200, so this is an omp-side limitation, not a
  subrouter or account problem. Use `sr codex` for the ChatGPT pool until omp
  advertises a current Codex version. The Claude pool is unaffected.
- **Models don't appear after marketplace install** — restart omp; extension
  modules load at session start (`/reload-plugins` refreshes skills/commands but
  not new extensions).
- **Remote subrouter** — set `SUBROUTER_URL=http://<host>:31415` in omp's
  environment.

## License

MIT © Alireza Bashiri. Not affiliated with manaflow-ai or oh-my-pi.
