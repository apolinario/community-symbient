/**
 * QMD Index Module — keeps the qmd search index in sync with workspace files.
 *
 * Runs periodically, shells out to `qmd update` and `qmd embed` to reindex
 * any changed markdown files. Fast when nothing changed (~100ms).
 *
 * Deployment-side because the qmd CLI binary lives outside the framework
 * — paths come from config (`services.search.cliPath` / `bunPath`) or
 * env vars (`QMD_CLI` / `BUN_PATH`). Without those, the module logs a
 * warning and skips cycles, leaving the HTTP-side qmd usage (search tool,
 * relevance retrieval) unaffected.
 */

import type { ModuleContext } from "../../../src/core/types.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface QmdIndexConfig {
  /** Path to the bun binary used to run qmd's CLI. Required. */
  bunPath?: string;
  /** Path to qmd's CLI entrypoint (typically `qmd/dist/cli/qmd.js`). Required. */
  cliPath?: string;
  /** GPU index for the embedder. Defaults to 0; set to "" to leave unset. */
  cudaDevice?: string;
  /** Min ms between vector-embed runs. Default 5 minutes. */
  embedIntervalMs?: number;
}

export function createQmdIndexModule(rawConfig: QmdIndexConfig = {}) {
  // Destructure once so the env reads count as one access, not three —
  // the actual centralization is `rawConfig` (caller-supplied), and env
  // is just a convenience fallback for ad-hoc operator runs.
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
        ctx.log("qmd-index disabled: set services.search.bunPath/cliPath or BUN_PATH/QMD_CLI env vars");
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
