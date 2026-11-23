# Project conventions

Use Node.js 24 and npm workspaces. Build shared types before dependent packages.

- Run `npm run typecheck`, `npm test`, `npm run test:browser`, and `node scripts/validate-skill.mjs` before a release.
- Keep the HTTP API and MCP schemas in `packages/shared` consistent with the web app.
- Personal records, databases, logs, and installation settings belong in the user's data directory, never in the repository.
- A saved capture is not evidence of mastery. Reading and writing have independent review histories.
- Preserve other Codex configuration when installing, updating, or uninstalling.
- Use Chinese for user documentation and interface labels; use clear English identifiers in code.
- Report what was actually tested. Windows is the first supported platform.
