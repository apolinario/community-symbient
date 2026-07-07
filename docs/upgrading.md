# Upgrading

The framework/deployment split is the upgrade contract:

- **Framework** — `src/`, `infra/`, `scripts/`, `setup`. Yours to `git pull`.
- **Your symbient** — `workspace/` (or an external dir via
  `SYMBIENT_CONFIG`) + your config file. The framework only reads these
  through registries and template rendering; no framework release edits
  them.

So an upgrade is:

```sh
git pull
npm install
npm test && npm run smoke     # optional sanity
systemctl restart <your-symbient>   # or however you run it
```

If you keep your deployment outside the repo (`./setup init ... --into`),
`git pull` can never conflict with your workspace at all. If your
deployment lives in-repo (like the Feÿ reference), your `workspace/` and
config are still untouched files — merges stay trivial.

Custom code belongs in `workspace/extensions/` ([extending](extending.md)).
If you find yourself editing `src/` to customize behavior, that's a
framework gap — open an issue instead; the seam should exist.

Config changes between releases are validated at boot: a misshaped config
fails loudly with per-field errors rather than half-starting.
