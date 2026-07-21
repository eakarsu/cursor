# Provenance and launch boundary

The independent `server/` has a documented Node build. The `vscode/` editor
checkout is incomplete: its expected `.nvmrc` and `scripts/code.sh` launcher are
absent, and a repository-wide license/provenance record was not found.

`./start.sh server` starts only the backend after dependencies and a secure
`server/.env` have been supplied. `./start.sh editor` reports missing paths and
will not run unverified editor source unless both the authoritative files are
restored and `ACKNOWLEDGE_UNVERIFIED_SOURCE=1` is explicitly set in an isolated
review environment.

An owner must still identify the source, license, trademark/branding rights,
and update/security responsibility for the editor fork. This file does not
grant those rights.
