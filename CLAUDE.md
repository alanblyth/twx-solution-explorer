# twx-solution-explorer

ThingWorx extension `SolutionExplorer`: an Angular app in a widget that explores extension and entity dependencies. See [README.md](README.md).

## ThingWorx knowledge

- Before work that touches ThingWorx (platform behaviour, permissions, extensions, widgets), read `thingworx-field-notes.md` in the sibling repository `twx-knowledge` (`../twx-knowledge/`), and use the `thingworx-platform` skill. Read it yourself.
- Do not edit the notes from here; report gaps to the "ThingWorx Knowledge" session.
- The Angular bundle is shared by widgets through a carrier widget (`se-common`) and a once-only loader with a name unique to this extension (`__seLoadElements`). Keep it unique.
- The app is client-side REST as the signed-in user. Do not add a backend service that runs as System.
- Entity source is JSON written by `extension/generate_entities.py` with the twxlab builders. Every import needs a higher version.
- Never commit PTC material or secrets. Never point tests or `dev_server.py` at a production platform.

## Coding

- Python for scripts (tested before use); long, meaningful names, no single-letter variables.
- Pure logic (analyser, resolver, layouts) stays free of Angular so `npm test` (node `--test`, type stripping) can run it: no TypeScript parameter properties or enums in those files.

## Git workflow

Follow the user's global gitflow rules in `~/.claude/CLAUDE.md`: work on `feature/*` branches cut from `develop`, merge with `--no-ff` once verified, stage named files, never force-push.
