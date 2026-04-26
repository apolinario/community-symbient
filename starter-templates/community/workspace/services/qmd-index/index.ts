/**
 * QMD Index Module — keeps the qmd search index in sync with the
 * workspace markdown.
 *
 * Periodically shells out to `qmd update` (BM25, fast — every cycle)
 * and `qmd embed` (vector, GPU-intensive — gated by an interval).
 * Paths come from env vars `BUN_PATH` and `QMD_CLI`. If either is
 * unset, the module logs a warning and skips cycles, leaving the
 * HTTP-side qmd usage (search tool, relevance retrieval) unaffected.
 */

import type { ModuleContext } from "../../../../../src/core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface QmdIndexConfig {
  /** Path to the bun binary. Defaults to env BUN_PATH. */
  bunPath?: string;
  /** Path to qmd's CLI entrypoint. Defaults to env QMD_CLI. */
  cliPath?: string;
  /** GPU index for the embedder. Default: 0. Set to "" to leave unset. */
  cudaDevice?: string;
  /** Min ms between vector-embed runs. Default 5 minutes. */
  embedIntervalMs?: number;
}

export function createQmdIndexModule(rawConfig: QmdIndexConfig = {}) {
  // Destructure env once so reads count as one centralized access.
  const { BUN_PATH, QMD_CLI, CUDA_VISIBLE_DEVICES } = process.env;
  const bun = rawConfig.bunPath ?? BUN_PATH ?? "";
  const cli = rawConfig.cliPath ?? QMD_CLI ?? "";
  const cudaDevice = rawConfig.cudaDevice ?? CUDA_VISIBLE_DEVICES ?? "0";
  const embedInterval = rawConfig.embedIntervalMs ?? 5 * 60 * 1000;

  let warned = false;
  let lastEmbedTime = 0;

  return async function qmdIndex(ctx: ModuleContext): Promise<void> {
    if (!bun || !cli) {
      if (!warned) {
        ctx.log("qmd-index disabled: set BUN_PATH and QMD_CLI env vars (or pass bunPath/cliPath in the module config)");
        warned = true;
      }
      return;
    }
    try {
      const { stdout: updateOut } = await execAsync(`${bun} ${cli} update`, { timeout: 30000 });
      const needsEmbed = updateOut.includes("need vectors") || updateOut.includes("new,");

      const now = Date.now();
      if (needsEmbed && (now - lastEmbedTime) >= embedInterval) {
        const env = cudaDevice ? `CUDA_VISIBLE_DEVICES=${cudaDevice} ` : "";
        const { stdout: embedOut } = await execAsync(`${env}${bun} ${cli} embed`, { timeout: 60000 });
        lastEmbedTime = now;
        const match = embedOut.match(/Embedded (\d+) chunks/);
        if (match) {
          ctx.log(`Reindexed: ${match[1]} chunks embedded`);
        }
      }
    } catch (err) {
      ctx.log(`Index error: ${err}`);
    }
  };
}
