import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDecider, decide, decideMany, probabilityOf } from "./decide.js";

let server: Server;
let url = "";
const seen: any[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqs = JSON.parse(body);
      seen.push(reqs);
      const answer = (r: any) => ({ answers: { q: r.questions.q.type === "noul" ? { type: "noul", noul: r.state.p } : { type: "choice", choice: "personal", probabilities: { personal: 0.7, nothing: 0.3 } } } });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ responses: reqs.map(answer) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

describe("decide", () => {
  test("sends the question from its markdown and batches states", async () => {
    configureDecider({ url });
    const answers = await decideMany("relevance", [{ p: 0.9 }, { p: 0.1 }]);
    expect(answers.map((a) => probabilityOf(a))).toEqual([0.9, 0.1]);
    const sent = seen.at(-1);
    expect(sent).toHaveLength(2);
    expect(sent[0].questions.q).toEqual({ type: "noul", instructions: "Does this passage help answer the question?" });
  });

  test("choice questions carry their criteria", async () => {
    configureDecider({ url });
    const a = await decide("discretion-personal", { message: "x" });
    expect(probabilityOf(a, "personal")).toBe(0.7);
    expect(Object.keys(seen.at(-1)[0].questions.q.criteria)).toEqual(["nothing", "public", "personal"]);
  });

  test("a workspace decision overrides the default", async () => {
    const ws = mkdtempSync(join(tmpdir(), "decide-"));
    mkdirSync(join(ws, "decisions"));
    writeFileSync(join(ws, "decisions", "relevance.md"), "---\ntype: noul\n---\nDoes {{symbient}} need this passage?\n");
    configureDecider({ url, workspacePath: ws });
    await decide("relevance", { p: 0.5 }, { symbient: "Glitchy" });
    expect(seen.at(-1)[0].questions.q.instructions).toBe("Does Glitchy need this passage?");
    configureDecider({ url, workspacePath: mkdtempSync(join(tmpdir(), "decide-")) });
  });

  test("fails open: no decider, an unknown decision, or a dead endpoint give null", async () => {
    configureDecider({});
    expect(await decide("relevance", {})).toBeNull();
    configureDecider({ url });
    expect(await decide("no-such-decision", {})).toBeNull();
    configureDecider({ url: "http://127.0.0.1:9" });
    expect(await decide("relevance", {})).toBeNull();
  });
});
