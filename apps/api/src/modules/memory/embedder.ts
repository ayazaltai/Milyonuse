import {
  EMBEDDING_DIMENSIONS,
  type Embedder,
  HashingEmbedder,
} from "@milyonuse/memory";
import { AppLogger } from "../../common/logging/logger.js";
import type { Env } from "../../config/env.js";

const ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
const TIMEOUT_MS = 20_000;

type Fetch = typeof fetch;

/**
 * Embeddings through the model router (D-03): the same key, the same privacy
 * settings as every other call — no provider keeps or trains on what is sent.
 * A failure is thrown, and the caller keeps the memory without a vector:
 * recall falls back to words, and the night's pass embeds it later.
 */
export class OpenRouterEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly options: { appUrl: string; zeroRetention: boolean },
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "http-referer": this.options.appUrl,
        "x-title": "Milyonuse",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
        provider: {
          data_collection: "deny",
          ...(this.options.zeroRetention ? { zdr: true } : {}),
        },
      }),
    });
    if (!response.ok)
      throw new Error(`embeddings refused (${response.status})`);
    const body = (await response.json()) as {
      data?: { index?: number; embedding?: number[] }[];
    };
    const data = [...(body.data ?? [])].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    if (
      data.length !== texts.length ||
      data.some((d) => d.embedding?.length !== this.dimensions)
    ) {
      throw new Error("embeddings came back in the wrong shape");
    }
    return data.map((d) => d.embedding!);
  }
}

/** The router's embeddings with a key; the deterministic embedder without one. */
export function embedderFor(env: Env, logger: AppLogger): Embedder {
  if (env.OPENROUTER_API_KEY) {
    return new OpenRouterEmbedder(
      env.OPENROUTER_API_KEY,
      env.MEMORY_EMBEDDING_MODEL,
      {
        appUrl: env.APP_BASE_URL,
        zeroRetention: env.AGENT_ZERO_RETENTION,
      },
    );
  }
  logger.log("memory embeddings: deterministic FNV-1a (no OPENROUTER_API_KEY)");
  return new HashingEmbedder();
}

export const MEMORY_EMBEDDER = Symbol("MEMORY_EMBEDDER");
