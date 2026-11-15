# Purffle Shorts GitHub Actions Dispatcher

This service is separate from `tiktok-auth/` and does not modify or call TikTok.

## What it can start

Only these workflows are exposed:

- `.github/workflows/daily-short.yml`
- `.github/workflows/daily-long-video.yml`

Instagram is intentionally not exposed because its workflows start automatically after the matching YouTube workflow succeeds. TikTok is intentionally excluded.

The service always dispatches against `main` and does not accept arbitrary repository names, refs, workflow IDs, inputs, or URLs.

## Deploy on Render

Create a **new Web Service** from this repository:

- Root Directory: `github-actions-dispatcher`
- Runtime: Node
- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/health`

Add these environment variables in Render:

- `GITHUB_TOKEN`: the fine-grained GitHub token. Keep it only in Render's secret environment variables; never commit it or paste it into chat.
- `DISPATCH_API_KEY`: a long random secret used by the caller. Render's blueprint can generate one automatically; otherwise generate a random value of at least 32 bytes.

The GitHub token needs access only to `agusebas12-sketch/purffle-shorts`, with Repository permissions `Actions: Read and write` and the required `Metadata: Read-only`. It expires on the date selected in GitHub and must be rotated before expiry.

## Verify

- `GET /health` should return HTTP 200 and `configured: true`.
- `POST /actions/dispatch` requires `Authorization: Bearer <DISPATCH_API_KEY>`.
- Example JSON: `{"workflow":"daily-short.yml"}`.

A successful response is HTTP 202 and means GitHub accepted the dispatch; it does **not** mean the video was generated or published. Verify the actual Actions run and downstream Instagram run separately.

## ChatGPT action

After deployment, replace the placeholder server URL in `openapi.yaml` with the Render service URL. Import that OpenAPI document into an authenticated custom action/client, using the Render `DISPATCH_API_KEY` as its Bearer credential. This repository service alone does not add a callable action to an ordinary ChatGPT conversation; the caller integration must be configured separately.

## Safety

- Never expose `GITHUB_TOKEN` to a browser or client.
- Never put either secret in source control, logs, issue comments, or chat.
- Do not enable arbitrary workflow dispatch or accept user-supplied GitHub URLs.
- Rotate/revoke credentials if exposed.
