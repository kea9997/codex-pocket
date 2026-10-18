# Codex Pocket — Synthetic Preview

A standalone synthetic subset of the full Codex Pocket Windows + Android source app. This preview does not connect to Codex, real accounts or Tailscale. Unofficial, not endorsed by OpenAI. Interface currently Korean.

Node.js 22+, no npm install:

```sh
node --test demo.test.mjs
node demo.mjs
```

Open http://127.0.0.1:47833 on the same computer. Stop with Ctrl+C. Do not proxy, tunnel or expose this demo: its synthetic session is not authentication.

Try reading/searching, results, original-message navigation, generated image zoom, code/raw copy, large drafts, quick instructions, tools and Back/Escape. The collapsed Synthetic Preview controls cycle token/reset scenarios, including zero, unknown, failure, stale and explicitly dated activity. Browser drafts/preferences use origin-scoped storage; use invented text and clear site data afterward.

Actual sends, uploads, creation, account login/switching, model discovery, native notifications/sharing, video and Android installation are not supported here. Visible unsupported controls return errors; no native backend exists. This subset is not proof of full-app compatibility or security. See the full repository's main README for Windows/Android setup and trust boundaries.

Review EXPORT-MANIFEST.json and every exported file. Original code is MIT, see LICENSE; compatibility names retain their respective trademarks. See LEGAL-REVIEW.md and CONTRIBUTING.md. No credentials, operational settings, schemas, binaries, actual chats or screenshots are included.
