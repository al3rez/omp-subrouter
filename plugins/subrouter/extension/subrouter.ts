/**
 * subrouter.ts — route omp through a local manaflow-ai/subrouter daemon.
 *
 * Subrouter (https://github.com/manaflow-ai/subrouter) is a local proxy that
 * pools multiple Claude Max / ChatGPT Pro subscriptions (and API keys) behind
 * one endpoint with sticky, rate-limit-aware account selection. This extension
 * registers that endpoint as omp providers so you can pick, e.g.:
 *
 *     subrouter/claude-opus-4-8        (Claude Max pool, Anthropic Messages API)
 *     subrouter-codex/gpt-5.2-codex    (ChatGPT pool, Codex Responses API)
 *
 * Setup (one time):
 *   npm i -g subrouter           # or: pipx install subrouter
 *   subrouter serve --addr 127.0.0.1:31415   # keep running (Windows has no LaunchAgent)
 *   sr add claude <name>         # add a Claude Max subscription (repeat as needed)
 *   sr add                       # add a Codex/ChatGPT account (optional)
 *
 * The local hop normally uses the non-secret placeholder token "subrouter"; the
 * daemon swaps in the real pooled account before forwarding upstream. A daemon
 * started with --cloud-config instead requires that config's localProxyToken,
 * which is resolved automatically. Override the endpoint with SUBROUTER_URL
 * (default http://127.0.0.1:31415) and the token with SUBROUTER_TOKEN.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Non-secret local-hop token accepted by a plain `subrouter serve`. */
const PLACEHOLDER_TOKEN = "subrouter";

/**
 * Resolve the token the daemon expects.
 *
 * A plain daemon accepts anything, but one started with --cloud-config rejects
 * every request that does not carry its localProxyToken, so fall back to that
 * file before using the placeholder.
 */
function subrouterToken(): string {
  const fromEnv = process.env.SUBROUTER_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  try {
    const cloudConfig = join(homedir(), ".config", "subrouter", "cloud.json");
    const token = JSON.parse(readFileSync(cloudConfig, "utf-8"))?.localProxyToken;
    if (typeof token === "string" && token.trim()) return token.trim();
  } catch {
    // No cloud config, or it is unreadable: the daemon is not cloud-gated.
  }

  return PLACEHOLDER_TOKEN;
}

/** Resolve the subrouter root, tolerating a trailing slash or a "/v1" suffix. */
function subrouterRoot(): string {
  const raw = (
    process.env.SUBROUTER_URL ??
    process.env.SUBROUTER_CODEX_BASE_URL ??
    "http://127.0.0.1:31415"
  ).trim();
  return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
}

interface ModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

// Anthropic ids subrouter forwards verbatim to a Claude Max account. Metadata
// mirrors omp's bundled catalog; `cost` is intentionally omitted so pricing is
// inherited from the catalog row of the same model id.
const CLAUDE_MODELS: ModelSpec[] = [
  { id: "claude-opus-5", name: "Opus 5 · Subrouter", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: "claude-opus-4-8", name: "Opus 4.8 · Subrouter", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: "claude-sonnet-5", name: "Sonnet 5 · Subrouter", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: "claude-sonnet-4-5", name: "Sonnet 4.5 · Subrouter", reasoning: true, contextWindow: 1_000_000, maxTokens: 64_000 },
  { id: "claude-haiku-4-5", name: "Haiku 4.5 · Subrouter", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
];

// Codex ids subrouter forwards to a ChatGPT account via the Responses wire.
// The gpt-5.x-codex ids were retired: the ChatGPT backend now answers them with
// `400 ... model is not supported when using Codex with a ChatGPT account`.
const CODEX_MODELS: ModelSpec[] = [
  { id: "gpt-6-sol", name: "GPT-6 Sol · Subrouter", reasoning: true, contextWindow: 1_100_000, maxTokens: 128_000 },
  { id: "gpt-6-astra", name: "GPT-6 Astra · Subrouter", reasoning: true, contextWindow: 1_100_000, maxTokens: 128_000 },
  { id: "gpt-6-luna", name: "GPT-6 Luna · Subrouter", reasoning: true, contextWindow: 1_100_000, maxTokens: 128_000 },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol · Subrouter", reasoning: true, contextWindow: 1_100_000, maxTokens: 128_000 },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna · Subrouter", reasoning: true, contextWindow: 1_100_000, maxTokens: 128_000 },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra · Subrouter", reasoning: true, contextWindow: 1_100_000, maxTokens: 128_000 },
  { id: "gpt-5.5", name: "GPT-5.5 · Subrouter", reasoning: true, contextWindow: 1_100_000, maxTokens: 128_000 },
];

function toModel(m: ModelSpec) {
  return {
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: ["text", "image"] as const,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
}

export default function subrouter(pi: ExtensionAPI): void {
  const root = subrouterRoot();
  const token = subrouterToken();

  try {
    // Claude Max pool — Anthropic base; omp appends /v1/messages itself.
    pi.registerProvider("subrouter", {
      name: "Subrouter · Claude pool",
      baseUrl: root,
      apiKey: token,
      api: "anthropic-messages",
      headers: { "X-Subrouter-Agent": "claude" },
      models: CLAUDE_MODELS.map(toModel),
    });

    // ChatGPT pool — omp's openai-codex-responses posts to {baseUrl}/codex/responses,
    // which subrouter serves under its ChatGPT backend base (/backend-api).
    //
    // Known limitation: the ChatGPT backend gates model availability on the
    // `version` header (the Codex client version). omp's codex transport sets
    // it to 0.153.0 and overwrites any provider header, so current model ids
    // come back as 400 "model is not supported when using Codex with a ChatGPT
    // account". The same request with version 0.156.1 succeeds. Until omp
    // advertises a current version, use `sr codex` for the ChatGPT pool.
    pi.registerProvider("subrouter-codex", {
      name: "Subrouter · Codex pool",
      baseUrl: `${root}/backend-api`,
      apiKey: token,
      api: "openai-codex-responses",
      headers: { "X-Subrouter-Agent": "codex" },
      models: CODEX_MODELS.map(toModel),
    });
  } catch (err) {
    pi.logger?.warn?.(`[subrouter] provider registration failed: ${String(err)}`);
    return;
  }

  // Non-blocking reachability hint; never blocks startup.
  void (async () => {
    try {
      const signal =
        typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
          ? AbortSignal.timeout(1500)
          : undefined;
      const res = await fetch(`${root}/_subrouter/health`, signal ? { signal } : {});
      if (!res.ok) throw new Error(`health ${res.status}`);
      pi.logger?.info?.(`[subrouter] daemon healthy at ${root}`);
    } catch {
      pi.logger?.warn?.(
        `[subrouter] daemon not reachable at ${root} — start it with ` +
          "`subrouter serve --addr 127.0.0.1:31415` and add accounts (`sr add`).",
      );
    }
  })();
}
