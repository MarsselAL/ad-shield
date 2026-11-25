# Contributing

Thanks for helping. AdBrake is a small MIT-licensed Manifest V3 extension (plain JavaScript,
no runtime dependencies).

## Reporting a bug
Open an issue using the bug report template. Include the site URL, your browser and version,
and whether other ad blockers are installed (please disable them to test).

## Changing code
1. Fork, create a branch.
2. Edit files in `src/`, then rebuild: `python3 tools/build.py` (the files in `build/` are committed).
3. Run `bash tests/run.sh` and `python3 tools/build.py --check`. All tests must pass.
4. Keep changes small and explain the why in the pull request.

## Rules for changes
- No telemetry, no remote code, no new permissions without a clear reason.
- Filter lists are rebuilt with `python3 -I tools/build_rules.py`; do not hand-edit generated
  files in `rules/` (hand-written ones are `rules/curated_hosts.txt`, `rules/removeparams.txt`,
  `rules/scriptlets.json`, `rules/youtube.json`).
- Do not paste GPL code; the project is MIT. See `NOTICE.md` for third-party licences.

See `docs/ARCHITECTURE.md` and `docs/TESTING.md` for how things fit together.
