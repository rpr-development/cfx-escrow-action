# cfx-escrow-action

A GitHub composite action that uploads a FiveM resource to the [Cfx.re Portal](https://portal.cfx.re) for escrow processing, then attaches the escrowed zip to a GitHub Release.

## What it does

1. Zips the resource directory (respecting `upload-config.json` or `fxmanifest.lua` escrow rules)
2. Authenticates with the Cfx.re Portal via a saved passkey (Puppeteer + virtual WebAuthn)
3. Creates or re-uploads the asset on the Portal
4. Waits for escrow processing (`state: active`)
5. Downloads the escrowed zip via a pre-signed URL
6. Creates a GitHub Release with the escrowed zip attached

## Usage

**With a build step** (e.g. JS obfuscation outputs to `dist/`):

```yaml
- name: Upload to Cfx.re Portal
  uses: rpr-development/cfx-escrow-action@main
  with:
    resource_dir: ${{ github.workspace }}/dist
    github_token: ${{ secrets.GITHUB_TOKEN }}
    cfx_passkey_credential: ${{ secrets.CFX_PASSKEY_CREDENTIAL }}
    cfx_auth_state: ${{ secrets.CFX_AUTH_STATE }}
    cfx_asset_id: ${{ vars.CFX_ASSET_ID }}
    github_pat: ${{ secrets.GITHUB_PAT }}
```

**Lua-only resource** (fxmanifest.lua is in the repo root):

```yaml
- name: Upload to Cfx.re Portal
  uses: rpr-development/cfx-escrow-action@main
  with:
    resource_dir: ${{ github.workspace }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    cfx_passkey_credential: ${{ secrets.CFX_PASSKEY_CREDENTIAL }}
    cfx_auth_state: ${{ secrets.CFX_AUTH_STATE }}
    cfx_asset_id: ${{ vars.CFX_ASSET_ID }}
    github_pat: ${{ secrets.GITHUB_PAT }}
```

> `resource_dir` must point to the folder that contains `fxmanifest.lua`. For repos where the manifest lives at the root, use `${{ github.workspace }}`. For repos that compile or copy files into a subdirectory first, point to that subdirectory instead (e.g. `${{ github.workspace }}/dist`).

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `resource_dir` | ✅ | Absolute path to the resource directory to upload |
| `github_token` | ✅ | GitHub token for creating releases (`secrets.GITHUB_TOKEN`) |
| `cfx_passkey_credential` | ✅ | Contents of `passkey-credential.json` |
| `cfx_auth_state` | ✅ | Contents of `auth-state.json` |
| `repo_name` | | Asset name on the Portal (defaults to repository name) |
| `cfx_asset_id` | | Known Portal asset ID — auto-discovered if empty (`vars.CFX_ASSET_ID`) |
| `github_pat` | | PAT with `actions:write` scope — used to save `CFX_ASSET_ID` and rotate `CFX_AUTH_STATE` |

## First-time setup

### 1. Register a passkey

Run `setup-passkey.ts` locally once to register a virtual WebAuthn passkey and save your session:

```bash
cd path/to/cfx-escrow-action
bun install
bun run setup-passkey
```

This opens a browser window:
1. Log in to the [Cfx.re Forum](https://forum.cfx.re/login)
2. Press Enter in the terminal
3. Click **Add passkey** on the security page (`/u/me/preferences/security`)
4. Give it a name (e.g. `cfx-deploy`) and confirm
5. Press Enter in the terminal

Two files are generated: `passkey-credential.json` and `auth-state.json`.

### 2. Add GitHub Secrets

```bash
gh secret set CFX_PASSKEY_CREDENTIAL --body "$(cat passkey-credential.json)" --repo your-org/your-repo
gh secret set CFX_AUTH_STATE         --body "$(cat auth-state.json)"         --repo your-org/your-repo
```

### 3. Optional: PAT for variable caching & session rotation

Create a [Personal Access Token](https://github.com/settings/tokens) with `repo` and `actions:write` scope and add it as `GITHUB_PAT`. This enables:
- Automatic saving of `CFX_ASSET_ID` as a repository variable (speeds up subsequent runs)
- Rotation of `CFX_AUTH_STATE` after each run (keeps the session fresh)

## Optional: upload-config.json

Place an `upload-config.json` in the resource root to exclude additional files from the upload:

```json
{
  "exclude": [".gitignore", ".github/**", "tests/**"]
}
```

If not present, defaults to excluding `.gitignore`, `.github/**` and `.claude/**`. The Portal reads `escrow_ignore {}` from `fxmanifest.lua` directly.

## Credits

Authentication logic based on [9am-build](https://github.com/ilovehugetits/9am-build).
