# publimapa

Cloudflare Worker powering the Publimapa WTC Concierge — a static frontend with an AI chat API backed by Google Gemini.

## Live domains

- https://publimapa.com
- https://www.publimapa.com

## Project structure

```
publimapa/
├── public/              ← Static site files (served by ASSETS binding)
│   ├── index.html       ← Main chat interface
│   ├── 404.html         ← Not-found page
│   └── .assetsignore    ← Excludes junk from uploads
├── src/
│   └── index.js         ← Worker code (API routes + asset fallback)
├── wrangler.toml        ← Cloudflare config (points to ./public)
├── package.json
├── .gitignore
└── .github/
    └── workflows/
        └── deploy.yml   ← Auto-deploy on push to main
```

## Deploy

Pushing to `main` triggers the GitHub Actions workflow, which runs `npx wrangler deploy`.

## Required GitHub repo secrets

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare token with Workers Scripts:Edit + DNS:Edit |
| `GEMINI_API_KEY` | Google Gemini API key |
| `GAS_API_URL` | Google Apps Script endpoint URL |

## API routes

- `POST /api/chat` — `{ "userMessage": "..." }` → JSON array of recommended businesses
- `POST /api/update-cache` — manually rebuild the Gemini context cache
