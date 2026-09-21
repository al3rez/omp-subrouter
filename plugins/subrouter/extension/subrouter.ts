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
 * The local hop uses the non-secret placeholder token "subrouter"; the daemon
 * swaps in the real pooled account before forwarding upstream. Override the
 * endpoint with SUBROUTER_URL (default http://127.0.0.1:31415).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Non-secret local-hop token, per subrouter's documented Codex/Claude wiring.
const LOCAL_TOKEN = "subrouter";

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
const CODEX_MODELS: ModelSpec[] = [
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex · Subrouter", reasoning: true, contextWindow: 272_000, maxTokens: 128_000 },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max · Subrouter", reasoning: true, contextWindow: 272_000, maxTokens: 128_000 },
  { id: "gpt-5.1-codex", name: "GPT-5.1 Codex · Subrouter", reasoning: true, contextWindow: 272_000, maxTokens: 128_000 },
  { id: "gpt-5-codex", name: "GPT-5 Codex · Subrouter", reasoning: true, contextWindow: 272_000, maxTokens: 128_000 },
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

  try {
    // Claude Max pool — Anthropic base; omp appends /v1/messages itself.
    pi.registerProvider("subrouter", {
      name: "Subrouter · Claude pool",
      baseUrl: root,
      apiKey: LOCAL_TOKEN,
      api: "anthropic-messages",
      headers: { "X-Subrouter-Agent": "claude" },
      models: CLAUDE_MODELS.map(toModel),
    });

    // ChatGPT pool — omp's openai-codex-responses posts to {baseUrl}/codex/responses,
    // which subrouter serves under its ChatGPT backend base (/backend-api).
    pi.registerProvider("subrouter-codex", {
      name: "Subrouter · Codex pool",
      baseUrl: `${root}/backend-api`,
      apiKey: LOCAL_TOKEN,
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
