# Contributing to the synthetic preview

Original contributions are MIT; see LICENSE and LEGAL-REVIEW.md. Do not copy third-party schemas/assets without provenance and compatible rights.

Use Node22+, run `node --test demo.test.mjs` and `node --check demo.mjs`. Review mobile/desktop, low keyboard height, focus, Back/Escape, stale usage and hidden/resumed pages in a real browser. Synthetic DOM checks are not CSS geometry or native evidence.

Use invented fixtures only; never publish actual conversations, screenshots, profiles, credentials, logs or signing material. Preserve fixed loopback routes/Host/Origin/CSP and rejection of production mutations. No external trackers or arbitrary file/RPC/shell bridges. Report sensitive security issues only through a maintainer-provided private channel; no inbox is assumed. Full-app changes need tests and threat-model review in the full source repository.
