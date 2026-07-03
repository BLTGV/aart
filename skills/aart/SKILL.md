---
name: aart
description: Create, validate, publish, edit, and revoke reviewable static HTML agent artifacts using unguessable Cloudflare R2 public links. Use when a user asks an agent to create or update an HTML/CSS/JS artifact, mockup, dashboard, report, demo, or other browser-viewable output that humans should review from multiple devices.
---

# AART

AART publishes static agent artifacts as unguessable capability links. Anyone with the link can view the artifact; the link is not authentication. Do not publish secrets, credentials, private data, or internal-only content unless the user explicitly confirms that capability-link sharing is acceptable.

## Workflow

1. Create or edit a local artifact directory containing `index.html` at its root and any assets under subdirectories such as `assets/`.
2. Keep the artifact static. Prefer self-contained HTML/CSS/JS and relative asset references.
3. Avoid references to `localhost`, `file://`, private network URLs, or uncommitted local files.
4. Validate the artifact:

```bash
npx @bltgv/aart validate <artifact-dir>
```

5. If publishing is requested and the project has not been configured, run:

```bash
npx @bltgv/aart doctor
```

If doctor reports missing configuration, tell the user to run setup with their bucket and public base URL:

```bash
npx @bltgv/aart setup --bucket <bucket> --base-url <https://public-r2-domain>
```

6. Publish:

```bash
npx @bltgv/aart publish <artifact-dir>
```

7. Return the published URL and state that it is an unguessable share link, not an authenticated private URL.

## Artifact Requirements

- Include `index.html` at the artifact root.
- Use relative URLs for local assets.
- Keep generated artifacts under a task-specific folder, not mixed into the application source tree.
- Do not create a public index or predictable alias for artifacts.
- Do not include secrets in HTML, JavaScript, source maps, JSON, images, or embedded metadata.

## URL And Access Model

AART publishes to:

```text
shares/{unguessable-token}/index.html
shares/{unguessable-token}/assets/...
shares/{unguessable-token}/manifest.json
```

The CLI generates the token with cryptographic randomness. Do not replace it with timestamps, slugs, issue numbers, branch names, repo names, or other guessable values.

## Revocation

To revoke a published artifact, run:

```bash
npx @bltgv/aart revoke <share-url-or-token>
```

Revocation deletes the objects listed in the published manifest. It does not prevent access to copies already downloaded or forwarded.
