# Violations Desk

An OSHA inspection review page for underwriting. The page is a single static
HTML file served from GitHub Pages; a Cloudflare Worker proxies the US
Department of Labor OSHA datasets so the DOL API key never reaches the browser.

```
index.html      the page itself (no build step, no dependencies)
config.js       the one file you edit: the Worker URL
worker/         the Cloudflare Worker (see worker/README.md)
.nojekyll       stops GitHub Pages from running Jekyll over the files
.github/        the Pages deploy workflow
```

## 1. Push the repo

```bash
git init
git add .
git commit -m "Violations Desk: page and OSHA proxy"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

## 2. Turn on Pages

In the repo: **Settings → Pages → Build and deployment → Source: GitHub
Actions**. The workflow in `.github/workflows/deploy-pages.yml` runs on every
push to `main` and publishes everything except `worker/` and the CI files.

The site lands at `https://<you>.github.io/<repo>/`.

If you would rather skip Actions, set Source to **Deploy from a branch →
main → / (root)**. The `.nojekyll` file matters either way.

## 3. Deploy the Worker

```bash
cd worker
npx wrangler secret put DOL_API_KEY     # your DOL Open Data Portal key
npx wrangler deploy
```

Then set `ALLOWED_ORIGINS` in `worker/wrangler.toml` to your Pages origin and
deploy again:

```toml
[vars]
ALLOWED_ORIGINS = "https://<you>.github.io"
```

That origin is the scheme and host only — no repo path, no trailing slash.
Without it the Worker allows any origin, which is fine locally but not for
something you leave running.

## 4. Point the page at the Worker

Edit `config.js`:

```js
window.VIOLATIONS_DESK_CONFIG = {
  apiBase: 'https://violations-desk-osha.<your-subdomain>.workers.dev'
};
```

Commit and push; Pages redeploys on its own.

## Using it

Open the page with an inspection in the query string:

| URL | What it does |
| --- | --- |
| `/` | empty page; Refresh OSHA Data adds a blank inspection to fill in by hand |
| `/?activity=1844208015` | pulls that inspection |
| `/?name=ACME&state=CA&since=2021-01-01` | pulls every match, up to `&limit=` (default 10) |
| `/?api=https://preview.example.workers.dev&activity=1844208015` | same, against a different Worker for one load |

Refresh OSHA Data re-pulls whatever the query string asks for. The status line
beside the button shows progress, the record count, or the error.

## Running it locally

`config.js` and `index.html` are plain files, but the page fetches from the
Worker, so serve it over HTTP rather than opening the file directly:

```bash
python3 -m http.server 8000      # then open http://localhost:8000/?activity=...
```

For the Worker, `npx wrangler dev` in `worker/` gives you a local URL to pass
as `?api=http://127.0.0.1:8787`.

## Notes

- Underwriter Notes are saved in the browser's local storage, so they stay on
  one machine and one browser. Moving them to a backend is the next step if
  more than one person needs to see them.
- Nature of Injury and Occupation arrive as numeric codes and need OSHA's IN
  and OCC code tables to become readable.
- Cited standard details are left blank for your standards data source to fill.
