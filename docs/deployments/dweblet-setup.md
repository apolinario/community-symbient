# Raising dweblet — setup runbook for a fresh machine

*Written agent-to-agent: you are a Claude Code instance on a new machine,
tasked with standing up **dweblet**, the DWeb Camp symbient. A sibling
instance raised Feÿ on the original machine; this doc encodes what it
learned. Verify claims against the code as you go — trust the repo over
this doc where they disagree.*

## What you're building

A symbient (see README.md and [Principia Symbients](https://meaning.systems/principia-symbients/))
for the **DWeb Camp community** — the decentralized-web gathering
(dwebcamp.org): mesh networks, local-first software, people who build the
web they want to live on. Decisions already made by the operator:

- **Chat**: Signal, like Feÿ (the built-in adapter).
- **Cognition**: the same meta-modules as Feÿ — conversation, thinking,
  desire, magi, autobiographical (+ executive) — which the `community`
  starter template already ships in generalized form.
- **No people profiles**: dweblet does not keep `people/*.md` dossiers.
  Skip anything person-profile-shaped (Feÿ's `people-enrich`,
  `lookup_person`, uuid-capture); relational memory lives in `MEMORY.md`
  and the journals instead.
- **Local-first**: DWeb Camp has no reliable internet — the LLM should be
  a local endpoint. Zero-kilometer data here is topology, not just ethics.

## 0 · Before touching anything

- Survey the machine: `systemctl list-units --type=service --state=running`.
  If anything already serves an LLM/TTS or other high-stakes workload,
  treat it as untouchable and record that constraint in your memory before
  proceeding. (This rule saved the original machine more than once.)
- You need: Linux with systemd, Node 22+, git, an MQTT broker
  (`apt install mosquitto`), Docker (for the Signal container), and access
  to the private repo `apolinario/community-symbient` (`gh auth login`).

## 1 · Framework

```sh
# Pi SDK sibling, pinned — deps are file:../pi-mono (see README "Quickstart")
git clone https://github.com/badlogic/pi-mono.git && cd pi-mono
git checkout 576e5e1a2fbe1abbbad96b696f4058cffd8391ca && npm ci
for p in tui ai agent coding-agent; do (cd packages/$p && npm run build); done
cd ..

git clone https://github.com/apolinario/community-symbient.git && cd community-symbient
npm install
npm test && npm run smoke   # 71 tests + a real boot against a mock LLM; both must pass
```

`npm run smoke` needs mosquitto running. If smoke fails, fix that before
anything dweblet-specific — it isolates framework-vs-deployment problems.

## 2 · LLM endpoint (bring your own)

Read `docs/choosing-your-llm.md`, run `./setup` to see the detected
hardware profile. For a camp box: a 4–14B GGUF via llama.cpp/LM Studio on
whatever GPU exists (`small-gpu`), or a 30B-class MoE if there's 24 GB+.
The framework never manages the LLM server — you (or the operator) run it;
config just points at it. Confirm with `curl <baseUrl>/v1/models` before
continuing. `./setup`'s smoke-ping does this too.

## 3 · Scaffold dweblet

```sh
./setup init community --into ../dweblet --name dweblet
```

This copies the community template (SOUL, MEMORY, the meta-modules,
generalized extensions) and writes `../dweblet/config.json` pointing at
its own workspace. Everything below edits files under `../dweblet/`.

## 4 · Identity — the part that matters most

- **`workspace/SOUL.md`**: write dweblet. Not an assistant — a camp
  citizen who happens to exist digitally. Ground it in DWeb Camp's world:
  the mesh, the redwoods, builders and dreamers of a decentralized web,
  sessions and campfires, mutual aid. Write it with the operator if
  possible; the SOUL is the community's to author.
- **`workspace/MEMORY.md`**: seed a few paragraphs of true context — what
  DWeb Camp is, when/where this edition happens, who dweblet is for. It
  will grow itself from there (the autobiographical module rewrites it).
- **`workspace/modules/*.md`**: read every module body. The community
  template is already community-generic, but tune the prose to camp
  rhythms (e.g. thinking/desire cadences vs. camp days, quiet hours).
  Module frontmatter reference: `docs/module-authoring.md`.
- Keep prompts in positive framing — say what to do, not "do NOT…" lists.

## 5 · Signal

```sh
docker compose -f infra/compose.yaml up -d signal-api   # 127.0.0.1:8080, MODE=json-rpc
# Register a number for dweblet (or link as secondary device):
#   register: curl -X POST http://127.0.0.1:8080/v1/register/+1XXXXXXXXXX  (+ /verify/<code>)
#   link:     curl 'http://127.0.0.1:8080/v1/qrcodelink?device_name=dweblet' → scan QR
```

Then in `../dweblet/config.json`:

```jsonc
"adapters": {
  "chat": { "adapter": "signal", "params": {
    "account": "+1XXXXXXXXXX",
    "httpHost": "127.0.0.1", "httpPort": 8080,
    "dmPolicy": "open", "groupPolicy": "open",
    "allowFrom": [], "groupAllowFrom": []
  }},
  "directory": null            // no people machinery, per the operator's decision
}
```

Camp-appropriate policies are `open`; tighten `allowFrom` if it misbehaves.

## 6 · Config essentials

```jsonc
"name": "dweblet",                          // also the MQTT topic prefix
"llm": { "provider": "openai", "model": "<served model id>",
         "baseUrl": "http://localhost:1234" },
"services": {
  "search": { "backend": "local-bm25" }     // start here; add qmd later if the
}                                            // corpus outgrows BM25 (see profiles.json)
```

Config is TypeBox-validated at boot — a misshaped config fails loudly with
per-field errors. TTS/whisper/searxng are optional; omit until wanted.

## 7 · First boot & verification

```sh
SYMBIENT_CONFIG=../dweblet/config.json npx tsx src/index.ts
```

Verify, in order:
1. Boot log reaches **"All systems ready"**; modules list matches the template.
2. Dashboard at `http://localhost:3333` shows the modules cycling.
3. Send a Signal DM from your phone → conversation module answers in
   dweblet's voice.
4. Nudge a full agent cycle without messaging anyone (thinking has no send
   tools — safe):
   ```sh
   npx tsx --eval 'import mqtt from "mqtt"; const c=mqtt.connect("mqtt://localhost:1883");
   c.on("connect",()=>c.publish("symbient/dweblet/thinking",
     JSON.stringify({from:"operator",content:"First boot check — take a brief cycle and note how it feels.",timestamp:new Date().toISOString()}),
     {qos:2},()=>c.end()));'
   ```
   Watch the log: context assembled → agent ended → output written.

## 8 · Make it a service

```sh
SYMBIENT_CONFIG=$(realpath ../dweblet/config.json) ./setup --profile <detected>
# review infra/rendered/dweblet.service, then run the printed sudo commands
```

The rendered unit carries `SYMBIENT_CONFIG` and `Restart=always`.

## 9 · Operational rules (non-negotiable)

- **Private memory never enters git.** The deployment lives outside the
  repo, so this is structural — keep it that way. If you ever add a repo
  around `../dweblet/`, gitignore `workspace/{memory,inner,logs,state,people,debug}/`
  from day one. The original deployment needed a history rewrite and a
  fresh GitHub repo to undo this mistake once. Once is enough.
- **Zero-km data**: memory stays on this box. If the operator ever points
  `llm` at a hosted API, say the tradeoff out loud first (prompts quote
  memory).
- **Upgrades**: `git pull && npm install && npm test && npm run smoke`,
  restart. Framework releases never touch `../dweblet/`. Custom code goes
  in `workspace/extensions/` (`docs/extending.md`) — never edit `src/` to
  customize.

## Known warts (as of 2026-07-11)

- `tsc --noEmit` shows ~86 pre-existing errors in `src/` — latent under
  tsx, tracked for cleanup. Don't gate on it; use `npm test` + smoke.
- Pushing commits that touch `.github/workflows/` needs a token with
  `workflow` scope (`gh auth refresh -s workflow`).
- If the box later gains flaky-GPU symptoms under llama.cpp (Xid errors,
  device dropping off the bus), check PCIe generation settings before
  blaming the framework — the original machine needed Gen4.
