# Deploy-Drift Guard

Catches **silent deploy failure**: CI says the deploy succeeded, but
production is still serving an old commit. Happens constantly — a build
cache goes stale, a CDN edge doesn't invalidate, a platform's deploy API
returns 200 before the new version is actually traffic-serving, a rollback
silently reverted. Your pipeline goes green. Your users are stuck on last
week's bug.

Deploy-Drift Guard fetches your live app and compares the commit SHA it
reports about itself against the SHA that's supposed to be live. If they
don't match, the step fails loudly, right in CI, right after deploy —
instead of someone noticing three days later.

## Why no API token or secret

Every other tool in this space asks for a Vercel/Netlify/AWS API token so
it can ask the platform "what's actually live?". That's a real trust
barrier: a stranger's GitHub Action asking for write-scoped deploy
credentials is a hard sell, and it's the #1 reason tools like this never
get adopted.

Deploy-Drift Guard asks your **app** instead of your **platform**. You
expose your own commit SHA through a response header, a JSON endpoint, or a
plain-text file — all things you already control and that cost nothing to
set up. No token. No scopes. No platform lock-in. It works identically on
Vercel, Netlify, Fly.io, a bare EC2 box, or anything else that serves HTTP.

## How it works

1. You add a step after your deploy step.
2. It fetches `url` (your live app or a dedicated version endpoint).
3. It looks for a commit SHA in the response, in this order:
   - **(a) a response header** (configurable name, default `x-deployed-sha`)
   - **(b) a JSON body field** (configurable `json-path`, e.g. `/api/version` → `{"sha": "abc123"}`)
   - **(c) a plain-text body that IS the SHA** (e.g. a `/version.txt` endpoint)
4. It compares that SHA against `expected-sha` (defaults to `github.sha` —
   the commit that triggered the workflow). Short and long SHAs both work;
   they're compared up to the length of whichever one is shorter.
5. **Match** → step passes. **Mismatch** → step fails (configurable).
   **Couldn't find a SHA at all** → step warns, never fails — a
   misconfigured header name shouldn't break everyone's CI on day one.

## Quick start

Add this as a step right after you deploy, in the same job (so `github.sha`
unambiguously refers to the commit you just shipped):

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy
        run: ./deploy.sh # however you ship — Vercel, Fly, your own script, etc.

      - name: Verify the deploy actually landed
        uses: your-org/deploy-drift-guard@v1
        with:
          url: https://example.com/api/version
          # expected-sha defaults to github.sha — override only if you need to.
```

That's it. No secrets to configure.

## The 3 ways to expose your SHA

Pick whichever is least effort for your stack. You only need one.

### (a) Response header

The least code: set one header on any response (often the fastest if your
platform/edge config can inject headers without touching app code).

**Vercel** — `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "x-deployed-sha", "value": "$VERCEL_GIT_COMMIT_SHA" }
      ]
    }
  ]
}
```

> Note: Vercel resolves `vercel.json` header *values* at deploy time from
> its own build environment, not literally like this at runtime for every
> request — if your platform doesn't support env interpolation in headers,
> set the header from app code instead (see the Next.js example below,
> adapted to `next.config.js`'s `headers()` function), or use option (b).

**nginx:**

```nginx
add_header X-Deployed-Sha "abc1234def5678" always;
```

(bake the real SHA into this file at build time, e.g. via a template step
in your CI that substitutes `$CI_COMMIT_SHA`)

Then:

```yaml
- uses: your-org/deploy-drift-guard@v1
  with:
    url: https://example.com/
    sha-header: x-deployed-sha
```

### (b) JSON endpoint

The most flexible — works great if you already have (or can cheaply add) a
health/status/version endpoint.

**Next.js API route** (`app/api/version/route.js`):

```js
export function GET() {
  return Response.json({
    sha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'unknown',
  });
}
```

Or, for the older `pages/api/version.js`:

```js
export default function handler(req, res) {
  res.json({ sha: process.env.VERCEL_GIT_COMMIT_SHA || 'unknown' });
}
```

Then:

```yaml
- uses: your-org/deploy-drift-guard@v1
  with:
    url: https://example.com/api/version
    json-path: sha
```

`json-path` supports nesting and array indices, e.g. `data.commit.sha` or
`deployments.0.sha`. If you omit `json-path` entirely, Deploy-Drift Guard
will try a handful of conventional field names automatically (`sha`,
`commitSha`, `commit_sha`, `commit.sha`, `gitSha`, `git_sha`, `version`,
`revision`) — handy if you don't control the endpoint shape exactly.

### (c) Plain-text endpoint

The simplest possible contract — a static file or route whose entire body
IS the SHA, nothing else.

```bash
# in your build step:
echo "$GITHUB_SHA" > public/version.txt
```

Then:

```yaml
- uses: your-org/deploy-drift-guard@v1
  with:
    url: https://example.com/version.txt
```

No `sha-header` or `json-path` needed — if the header isn't present and the
body isn't JSON, Deploy-Drift Guard checks whether the trimmed body text
itself looks like a hex commit SHA and uses it directly.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `url` | yes | — | Public URL to check for the live commit SHA. |
| `expected-sha` | no | `${{ github.sha }}` | The SHA that should be live. |
| `sha-header` | no | `x-deployed-sha` | Response header to check first. Case-insensitive. |
| `json-path` | no | `''` | Dot-path into a JSON body, e.g. `data.commit.sha`. Empty = try common field names automatically. |
| `min-match-length` | no | `7` | Minimum hex chars required to treat a found value as a real SHA. |
| `timeout-ms` | no | `10000` | Request timeout for fetching `url`. |
| `fail-on-drift` | no | `true` | Hard-fail the step on a confirmed mismatch. Set `false` to warn-only while you build trust in the signal. |
| `fail-on-error` | no | `false` | Hard-fail the step when the check couldn't be performed at all (endpoint unreachable, timed out, non-2xx, or no SHA found in the response). Defaults to warn-only so a flaky network blip or a not-yet-wired-up endpoint can't silently break CI on day one — flip to `true` once you've confirmed the happy path works, so a broken health-check path gets caught instead of warning forever. |

## Outputs

| Output | Description |
|---|---|
| `status` | One of `match`, `drift`, `not-found`, `error`. |
| `deployed-sha` | The SHA extracted from the live deployment, if found. |
| `expected-sha` | The SHA that was expected to be live (echoes the resolved input). |
| `drift-detected` | `"true"` on a confirmed mismatch, `"false"` on a match, `"unknown"` if no SHA could be found. |

Example using the outputs to notify elsewhere on drift:

```yaml
- name: Verify the deploy actually landed
  id: drift
  uses: your-org/deploy-drift-guard@v1
  with:
    url: https://example.com/api/version
    json-path: sha
    fail-on-drift: 'false' # we'll decide what to do with the result ourselves

- name: Alert on drift
  if: steps.drift.outputs.status == 'drift'
  run: |
    echo "Expected ${{ steps.drift.outputs.expected-sha }}, found ${{ steps.drift.outputs.deployed-sha }}"
    # curl your Slack webhook, open an issue, whatever fits your stack
```

## Design notes

- **Zero runtime dependencies.** `index.js` uses only Node 20 built-ins
  (`fetch`, `AbortController`, `fs`). Nothing to audit, nothing to update.
- **Short vs. long SHA comparison.** Git SHAs show up as 7-char abbreviations
  in some places and full 40-char hashes in others. Both sides are truncated
  to the shorter length before comparing, so `abc1234` correctly matches
  `abc1234def5678901234567890abcdef12345678`.
- **"Not found" is never a hard failure**, intentionally. A wrong header
  name or an endpoint that's temporarily down shouldn't break a team's CI
  on their first day using this. Tune `sha-header` / `json-path` until
  `status` reliably comes back `match` or `drift`, *then* rely on
  `fail-on-drift`.
- **Not a replacement for real deploy-platform health checks.** This checks
  one thing: does the live app's self-reported SHA match what you expect.
  It's a cheap, secret-free tripwire for the specific "CI lied" failure
  mode — not a full observability or rollout-health solution.

## License

MIT — see [LICENSE](./LICENSE).
