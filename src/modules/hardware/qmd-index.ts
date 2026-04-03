/**
 * QMD Index Module — keeps the qmd search index in sync with workspace files.
 *
 * Runs periodically, shells out to `qmd update` and `qmd embed` to reindex
 * any changed markdown files. Fast when nothing changed (~100ms).
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ModuleContext } from "../../core/types.js";

const execAsync = promisify(exec);

const BUN = process.env.BUN_PATH || "/home/plantoidz/.bun/bin/bun";
const QMD_CLI = process.env.QMD_CLI || "/home/plantoidz/pi/qmd/dist/cli/qmd.js";

export function createQmdIndexModule() {
  let lastEmbedTime = 0;
  const EMBED_INTERVAL = 5 * 60 * 1000; // Full embed every 5 min

  return async function qmdIndex(ctx: ModuleContext): Promise<void> {
    try {
      // BM25 update every cycle (30s) — fast, just checks file hashes
      const { stdout: updateOut } = await execAsync(`${BUN} ${QMD_CLI} update`, { timeout: 30000 });
      const needsEmbed = updateOut.includes("need vectors") || updateOut.includes("new,");

      // Vector embed only every 5 min — GPU intensive
      const now = Date.now();
      if (needsEmbed && (now - lastEmbedTime) >= EMBED_INTERVAL) {
        const { stdout: embedOut } = await execAsync(`${BUN} ${QMD_CLI} embed`, { timeout: 60000 });
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
