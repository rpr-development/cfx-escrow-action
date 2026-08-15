# cfx-escrow-action

A GitHub composite action that uploads a FiveM resource to the [Cfx.re Portal](https://portal.cfx.re) for escrow processing, then attaches the escrowed zip to a GitHub Release.

## What it does

1. Zips the resource directory (respecting `upload-config.json` or `fxmanifest.lua` escrow rules)
2. Authenticates with the Cfx.re Portal — persisted session cookie first, saved passkey (Puppeteer + virtual WebAuthn) as fallback
3. Creates or re-uploads the asset on the Portal
4. Waits for escrow processing (`state: active`)
5. Downloads the escrowed zip via a pre-signed URL
6. Creates a GitHub Release with the escrowed zip attached

## Usage

**With a build step** (e.g. JS obfuscation outputs to `dist/`):

```yaml
- name: Upload to Cfx.re Portal
  uses: rpr-development/cfx-escrow-action@v1
  with:
    resource_dir: ${{ github.workspace }}/dist
    github_token: ${{ secrets.GITHUB_TOKEN }}
    cfx_passkey_credential: ${{ secrets.CFX_PASSKEY_CREDENTIAL }}
    cfx_asset_id: ${{ vars.CFX_ASSET_ID }}
    github_pat: ${{ secrets.GH_PAT }}
```

**Lua-only resource** (fxmanifest.lua is in the repo root):

```yaml
- name: Upload to Cfx.re Portal
  uses: rpr-development/cfx-escrow-action@v1
  with:
    resource_dir: ${{ github.workspace }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    cfx_passkey_credential: ${{ secrets.CFX_PASSKEY_CREDENTIAL }}
    cfx_asset_id: ${{ vars.CFX_ASSET_ID }}
    github_pat: ${{ secrets.GH_PAT }}
```

> `resource_dir` must point to the folder that contains `fxmanifest.lua`. For repos where the manifest lives at the root, use `${{ github.workspace }}`. For repos that compile or copy files into a subdirectory first, point to that subdirectory instead (e.g. `${{ github.workspace }}/dist`).

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `resource_dir` | ✅ (deploy) | Absolute path to the resource directory to upload |
| `github_token` | ✅ | GitHub token for creating releases (`secrets.GITHUB_TOKEN`) |
| `mode` | | `deploy` (default) or `keepalive` — keepalive only refreshes and persists the forum session, see [Session keep-alive](#session-keep-alive) |
| `cfx_passkey_credential` | | Contents of `passkey-credential.json` — fallback login and trigger for automatic recovery |
| `repo_name` | | Asset name on the Portal (defaults to repository name) |
| `cfx_asset_id` | | Known Portal asset ID — auto-discovered if empty (`vars.CFX_ASSET_ID`) |
| `cfx_session_cookie` | | Persisted forum session from a previous run (`secrets.CFX_SESSION_COOKIE`) — skips login entirely |
| `cfx_totp_secret` | | Base32 TOTP secret of the account's authenticator (`secrets.CFX_TOTP_SECRET`) — required for email login when 2FA is enabled |
| `cfx_imap_credentials` | | JSON `{"host","user","password","port"}` for the account's mailbox (`secrets.CFX_IMAP_CREDENTIALS`) — enables automatic recovery from the new-device block |
| `cfx_email_login_url` | | Manual fallback: one-time "Log in via link" URL from the Cfx forum email — see [New device/location block](#new-devicelocation-block) |
| `github_pat` | | PAT (`secrets.GH_PAT`, fine-grained: Secrets + Variables read/write) — used to save `CFX_ASSET_ID` (variable) and `CFX_SESSION_COOKIE` (secret) |

## First-time setup

### 1. Register a passkey

Not strictly required in a session-first setup, but strongly recommended: the passkey is the fallback login and the trigger for automatic recovery. Run `setup-passkey.ts` locally once to register a virtual WebAuthn passkey:

```bash
cd path/to/cfx-escrow-action
bun install
bun run setup-passkey
```

This opens a browser window:
1. Log in to the [Cfx.re Forum](https://forum.cfx.re/login)
2. Press Enter in the terminal
3. Click **Add passkey** on the security page
4. Give it a name (e.g. `cfx-deploy`) and confirm
5. Press Enter in the terminal

One file is generated: `passkey-credential.json`.

### 2. Add GitHub Secret

```bash
gh secret set CFX_PASSKEY_CREDENTIAL --body "$(cat passkey-credential.json)" --repo your-org/your-repo
```

### 3. Bootstrap the forum session

Log in once locally and store the long-lived session cookie as a secret — later runs restore this session instead of logging in, which avoids the [new device/location block](#new-devicelocation-block) entirely:

```bash
bun run setup-session your-org/your-repo [more/repos ...]
```

The repo arguments are optional: with them the script sets secret `CFX_SESSION_COOKIE` on each repo directly (requires an authenticated `gh` CLI); without them it prints the captured cookie with a ready-made `gh secret set` command to run yourself.

Also add a PAT as secret `GH_PAT`: a fine-grained token with **Secrets: read and write** + **Variables: read and write**, or a classic token with `repo` scope. It lets the action save `CFX_ASSET_ID` (skips asset discovery) and write the rotated session cookie back to `CFX_SESSION_COOKIE` after every run, keeping the session alive indefinitely.

### 4. Optional: automatic recovery secrets

If the stored session ever becomes invalid (no deploys for ~60 days, forum-side invalidation), the action falls back to a passkey login, which the forum may block. With these two secrets that recovery is fully automatic as well:

```bash
# Base32 secret of the account's authenticator app (shown when adding an authenticator
# on forum.cfx.re → Preferences → Security)
gh secret set CFX_TOTP_SECRET --body "<base32-secret>" --repo your-org/your-repo

# IMAP access to a mailbox that receives the login mail
gh secret set CFX_IMAP_CREDENTIALS --repo your-org/your-repo --body \
  '{"host": "mail.example.com", "user": "user@example.com", "password": "...", "port": 993, "waitMinutes": 3}'
```

Any mailbox with IMAP password access works (own mail server, Gmail/Fastmail with an app password, etc.). It also does not have to be the Cfx account's own inbox — a dedicated address that only receives the "Log in via link" mails keeps your main mailbox credentials out of CI:

- **Auto-forward rule** (recommended): forward mails from `thiscamefrom@fivem.net` / subject "Log in via link" to the dedicated address in your mail server — recovery stays fully automatic.
- **Manual forward**: the blocked run keeps running and polls the mailbox for `waitMinutes` (default 3) — set it to e.g. `15` so you have time to forward the mail yourself while the run waits. Forwarding inline or as attachment both work.

Without these secrets, a broken session means one manual step (see the [manual fallback](#new-devicelocation-block)).

## New device/location block

The Cfx forum can refuse a login with:

> It looks like you're connecting from a new device or location. To keep your account secure, you need to log in via email.

GitHub-hosted runners get a different IP every run, so passkey logins can hit this on any run. The forum then automatically mails a one-time login link (subject **"Log in via link"**) to the account's email address; completing that link also requires the account's TOTP code when 2FA is enabled.

The action handles this in three layers:

1. **Session persistence** (`cfx_session_cookie` + `github_pat`): after every successful login the forum session cookie (valid ~60 days) is saved as secret `CFX_SESSION_COOKIE`. Later runs restore the session instead of logging in — resuming a session does not trigger the new-device check at all, so normal runs never see the block.
2. **Automatic recovery** (`cfx_imap_credentials` + `cfx_totp_secret`): when a login is blocked anyway, the action polls the account's mailbox over IMAP for the "Log in via link" mail that the blocked attempt just triggered, opens the link, fills in a TOTP code generated from the secret and completes the login unattended.
3. **Manual fallback** (no mailbox access configured): the action fails with instructions. Copy the link from the **newest** "Log in via link" email — every blocked attempt sends a new link and invalidates older ones — store it and re-run:

   ```bash
   gh variable set CFX_EMAIL_LOGIN_URL --body "<link>" --repo your-org/your-repo
   ```

   The variable is deleted after use (the link is single-use). Alternatively, pass the link via the `cfx_email_login_url` input.

With layers 1 + 2 configured, deploys are fully hands-free.

Note that the passkey attempt is what *triggers* the recovery mail: without `cfx_passkey_credential` a dead session cannot start the automatic recovery, so keep the passkey configured even in a session-first setup.

## Session keep-alive

Deploys refresh the persisted session as a side effect, but a repo that goes quiet for ~60 days would come back to a dead session. Add a scheduled workflow with `mode: keepalive` to prevent that: it restores the session, lets the fallback layers re-establish it unattended when it died, and persists the resulting cookie — nothing else runs.

See [`examples/session-keepalive.yml`](examples/session-keepalive.yml) for a ready-made weekly workflow. GitHub disables scheduled workflows after ~60 days without repository activity, so an occasional commit (or manual `workflow_dispatch` run) is still needed in fully dormant repos.

## Optional: upload-config.json

Place an `upload-config.json` in the resource root to exclude additional files from the upload:

```json
{
  "exclude": [".gitignore", ".github/**", "tests/**"]
}
```

If not present, defaults to excluding `.gitignore`, `.github/**` and `.claude/**`. The Portal reads `escrow_ignore {}` from `fxmanifest.lua` directly.

## Examples

A ready-to-use workflow for a standard Lua resource (no build step) is available in [`examples/release.yml`](examples/release.yml). Copy it to `.github/workflows/release.yml` in your resource repo.

## Credits

Authentication logic based on [9am-build](https://github.com/ilovehugetits/9am-build).
