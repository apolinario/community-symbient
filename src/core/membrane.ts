/**
 * The membrane — the check a distilling module's output passes before it
 * becomes public (docs/stream.md). It holds back text that names someone
 * known only from private entries, or that repeats words from private
 * conversations. Paraphrase can still pass; this catches the plain leaks.
 */

import { readStream, inCategories } from "./stream.js";

const PRIVATE_SOURCES = ["perception.chat.dm", "effector.said.dm"];
const STOP = new Set("a an and are as at be but by for from had has have he her his i i'm in is it it's me my not of on or our she so that the their them they this to us was we were what when who will with you your".split(" "));

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
function trigrams(s: string): Set<string> {
  const w = words(s);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) {
    const g = w.slice(i, i + 3);
    if (g.filter((x) => STOP.has(x)).length < 2) out.add(g.join(" "));
  }
  return out;
}
const mentions = (text: string, name: string) =>
  new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u").test(text);

/** Why `text` can't go public, or null when it can. */
export async function membraneLeak(text: string, names: string[]): Promise<string | null> {
  const entries = await readStream({ includePrivate: true });
  const priv = entries.filter((e) => e.private);
  const publicText = entries.filter((e) => !e.private).map((e) => e.text).join("\n");
  const privateText = priv.map((e) => e.text).join("\n");
  for (const name of names) {
    if (mentions(text, name) && mentions(privateText, name) && !mentions(publicText, name)) {
      return `names ${name}, known only from private conversations`;
    }
  }
  const said = trigrams(priv.filter((e) => inCategories(e.category, PRIVATE_SOURCES)).map((e) => e.text).join("\n"));
  const open = trigrams(publicText);
  const echoed = [...trigrams(text)].filter((g) => said.has(g) && !open.has(g));
  return echoed.length ? `repeats words from a private conversation ("${echoed[0]}")` : null;
}
