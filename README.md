# AART

AART is an agent skill and CLI for publishing static HTML artifacts to unguessable Cloudflare R2 URLs so humans can review them from any device.

The MVP uses a public R2 bucket with a custom domain. It does not use a Worker, login wall, or artifact index. URLs are capability links: anyone with the URL can view the artifact, but the token is generated with cryptographic randomness and should not be guessable.

## Install The Skill

Project install for Codex:

```bash
npx skills add BLTGV/aart --skill aart --agent codex -y
```

Global install:

```bash
npx skills add BLTGV/aart --skill aart --agent codex -g -y
```

## Configure Publishing

Authenticate Wrangler first:

```bash
npx wrangler login
```

Then configure AART in your project:

```bash
npx @bltgv/aart setup --bucket aart --base-url https://aart.example.com
```

This writes `.aart/config.json`. It should be committed. Do not put secrets in that file.

For CI or headless environments, use Cloudflare environment variables:

```bash
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

## Check Setup

```bash
npx @bltgv/aart doctor
```

`doctor` checks Wrangler, authentication, config, the R2 bucket, and public read access by uploading and fetching a temporary health object.

## Publish

Create an artifact directory with `index.html`:

```bash
artifact/
  index.html
  assets/
```

Validate and publish:

```bash
npx @bltgv/aart validate ./artifact
npx @bltgv/aart publish ./artifact
```

AART uploads to:

```text
shares/{unguessable-token}/index.html
shares/{unguessable-token}/assets/...
shares/{unguessable-token}/manifest.json
```

The command returns a URL like:

```text
https://aart.example.com/shares/{unguessable-token}/index.html
```

## Revoke

```bash
npx @bltgv/aart revoke https://aart.example.com/shares/{token}/index.html
```

Revocation deletes the objects listed in `manifest.json`. It does not prevent access to already downloaded copies.

## Cloudflare Notes

- Use a custom R2 domain for normal use.
- Keep `r2.dev` for testing only.
- AART uploads `robots.txt` with `Disallow: /`.
- AART injects `<meta name="robots" content="noindex,nofollow">` into uploaded HTML if missing.
- Unguessable URLs are easy sharing, not authentication.
