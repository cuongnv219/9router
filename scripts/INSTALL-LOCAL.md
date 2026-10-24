# Build and install this repo as your `9router`

Use this to run your own build (for example with the per-key daily budget)
instead of the `9router` package published on npm. It works on macOS and Linux.

## One command

```bash
cd /path/to/9router
scripts/install-local.sh
```

The script runs these steps, in order:

1. Checks that Node.js is 22.5 or newer.
2. Updates `master` with `git pull --ff-only`. It stops if you have uncommitted changes.
3. Installs dependencies and builds the CLI package `9router-<version>.tgz` (a few minutes).
4. Backs up `~/.9router` (your keys, providers, combos, usage and budgets) to `~/9router-backup-<date-time>`.
5. Installs the package globally, replacing any existing `9router`, and checks the version.
6. Starts `9router --skip-update` and opens the dashboard at http://localhost:20128/dashboard.

### Options

| Option | Effect |
|---|---|
| `--no-pull` | Build the current checkout as-is (any branch, local changes included) |
| `--no-start` | Install only, don't start |
| `--tray` | Start in the menu-bar tray (runs in the background) |
| `--port <n>` | Start on another port |

Example: `scripts/install-local.sh --no-pull --tray`

## Your data is kept

Data lives in `~/.9router/`, outside the installed package, so reinstalling
does not touch it. On the first start a new build adds its new tables and columns
in place, after saving a copy under `~/.9router/db/backups/`. Existing API keys
keep working; keys have no budget until you set one.

If you run 9router with a custom `DATA_DIR` (Docker, `.env`), run the script with
the same value so the backup covers the right folder:
`DATA_DIR=/var/lib/9router scripts/install-local.sh`

## Starting it later

```bash
9router --skip-update          # dashboard + server
9router --skip-update --tray   # background, menu-bar icon
```

**Always pass `--skip-update`.** Otherwise, when upstream publishes a newer
version, the start-up menu offers "Update to v…". Choosing it installs the
upstream npm package over your build, and the per-key budget feature is gone.
Your data stays.

## Update to newer code

Run `scripts/install-local.sh` again. It pulls, rebuilds, backs up and reinstalls.

## Roll back

```bash
npm install -g 9router@<previous-version>   # e.g. 9router@0.5.40
```

The script prints the version it replaced. Older versions ignore the budget
columns and keep working with the same data. To restore a backup instead, stop
9router and copy it back:

```bash
cp -R ~/9router-backup-<date-time>/. ~/.9router/
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `9router on PATH reports … expected …` | Another `9router` comes first on your PATH (e.g. a different Node version manager). Check `which -a 9router`. |
| `Uncommitted changes` | Commit or stash them, or use `--no-pull`. |
| Port already in use | The CLI stops older 9router processes itself; otherwise use `--port`. |
| Dashboard shows no keys/providers | 9router is reading a different data folder. Check `DATA_DIR`. |
