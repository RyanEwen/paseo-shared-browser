# Shared Browser development

This is the standalone Shared Browser plugin repository. Keep the `shared-browser` runtime ID and all retained fork features.

- Run `bun install --frozen-lockfile`, `npm run check`, `npm run build`, `npm run typecheck`, `npm run test:scripts`, and `npm run test:unit` from this directory.
- Production dependencies are locked by `npm-shrinkwrap.json`; development dependencies by `bun.lock`. Do not create a competing `package-lock.json`.
- Runtime and UI checks must use an isolated Paseo home and explicit host. Use `scripts/dev-daemon.sh` for daemon verification. Never reload an active user plugin or replace its supervisor during development without explicit approval covering browser-state loss.
- Preserve original license and attribution. Do not change versions/changelogs or publish npm packages unless explicitly requested.
- Before upstream contributions, read `docs/standalone-migration.md`. The original monorepo remains separate and may contain an unresolved merge.
