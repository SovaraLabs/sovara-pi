# Sovara for Pi

Give Pi your team's knowledge. Sovara retrieves relevant lessons for each request and records
your sessions for review.

The Pi extension is in [`typescript/`](typescript): `pi install npm:@sovara/pi`. See its
[README](typescript/README.md).

## Development

The packages use the Sovara SDK from a [sovara](https://github.com/SovaraLabs/sovara) checkout
next to this repository (`../sovara`).
CI checks out sovara's `main` branch (set the `SOVARA_REF` repository variable to use
another one) with the `SOVARA_REPO_TOKEN` secret, a token that can read `SovaraLabs/sovara`.

TypeScript (`typescript/`): build the SDK first, then run the checks:

```sh
(cd ../sovara/packages/typescript-sdk && npm ci && npm run build)
cd typescript
npm ci
npm run check
```

### End-to-end tests

These run against a real Sovara exec server, started from the sovara checkout (set
`SOVARA_SOURCE_DIR` to use another one). Run `uv sync` there and start its Postgres with
`./dev.sh` or `docker compose -f deploy/dev/compose.yaml up -d`. No model is called.

```sh
cd typescript && npm run test:e2e
```

Without a sovara checkout they are skipped. CI doesn't run them.

## License

MIT.
