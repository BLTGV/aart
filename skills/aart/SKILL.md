---
name: aart
description: Create, validate, publish, edit, and revoke reviewable static HTML agent artifacts using unguessable Cloudflare R2 public links. Use when a user asks an agent to create or update an HTML/CSS/JS artifact, mockup, dashboard, report, demo, or other browser-viewable output that humans should review from multiple devices.
---

# AART

AART publishes static agent artifacts as unguessable capability links. One configured repository can publish many independent artifact directories; every publish creates its own unguessable share token and URL. `.aart/config.json` is project publishing configuration only, not state for a single artifact.

Anyone with a published link can view that artifact; the link is not authentication. Do not publish secrets, credentials, private data, or internal-only content unless the user explicitly confirms that capability-link sharing is acceptable.

The AART CLI is not published to npm yet. Run it with `npx github:BLTGV/aart ...`, or with `aart ...` after installing globally from GitHub.

## Workflow

1. Create or edit a local artifact directory containing `index.html` at its root and any assets under subdirectories such as `assets/`. Use a separate directory for each independent artifact.
2. Keep the artifact static. Prefer self-contained HTML/CSS/JS and relative asset references.
3. Avoid references to `localhost`, `file://`, private network URLs, or uncommitted local files.
4. Validate the artifact:

```bash
npx github:BLTGV/aart validate <artifact-dir>
```

5. If publishing is requested and the project has not been configured, run:

```bash
npx github:BLTGV/aart doctor
```

If doctor reports missing configuration, tell the user to run setup with their bucket and public base URL:

```bash
npx github:BLTGV/aart setup --bucket <bucket> --base-url <https://public-r2-domain>
```

If the user wants one publishing default across projects, use user-level setup:

```bash
npx github:BLTGV/aart setup --user --bucket <bucket> --base-url <https://public-r2-domain>
```

Project config lives at `.aart/config.json`; commit it when the project needs shared publishing settings. User config lives at `~/.config/aart/config.json`, or `$XDG_CONFIG_HOME/aart/config.json` when `XDG_CONFIG_HOME` is set; do not commit it. If both exist, AART merges them with project config overriding user config field by field. Both config files store only reusable publishing configuration such as bucket, base URL, prefix, cache, and token size. They are not manifests, registries, or pointers to one artifact.

AART passes `--remote` to Wrangler `r2 object get`, `put`, and `delete` so artifact object operations target the real R2 bucket.

6. Publish:

```bash
npx github:BLTGV/aart publish <artifact-dir>
```

If the user asks to keep the link in the project for later reference, publish with `--save`:

```bash
npx github:BLTGV/aart publish <artifact-dir> --save
```

This appends the share URL and metadata to `.aart/shares.json`. Do not use `.aart/config.json` for artifact history. Saved URLs are capability links; only save or commit them when the project audience should be able to open the artifacts.

7. Return the published URL and state that it is an unguessable share link, not an authenticated private URL.

## Artifact Requirements

- Include `index.html` at the artifact root.
- Use relative URLs for local assets.
- Keep generated artifacts under a task-specific folder, not mixed into the application source tree.
- Do not create a public index or predictable alias for artifacts.
- Do not include secrets in HTML, JavaScript, source maps, JSON, images, or embedded metadata.

## URL And Access Model

Each publish writes a separate tokenized prefix:

```text
shares/{unguessable-token}/
shares/{unguessable-token}/index.html
shares/{unguessable-token}/assets/...
shares/{unguessable-token}/manifest.json
```

The returned share URL ends at `shares/{unguessable-token}/`; the reviewer does not need to type `index.html`. The CLI generates the token with cryptographic randomness. Do not replace it with timestamps, slugs, issue numbers, branch names, repo names, or other guessable values. Do not assume the repository has only one artifact; publish each artifact directory separately and keep the returned URL for that specific share.

## Revocation

To revoke a published artifact, run:

```bash
npx github:BLTGV/aart revoke <share-url-or-token>
```

Revocation deletes the objects listed in the published manifest. It does not prevent access to copies already downloaded or forwarded.

Revocation is scoped to one share token. Other artifacts published from the same repository configuration are unaffected.
