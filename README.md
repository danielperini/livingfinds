# Living Finds

Living Finds is a React/Vite application with a self-hosted Deno backend and PostgreSQL database. Production is hosted on a Hostinger VPS and deployed by GitHub Actions. The `base44/` directory contains compatibility functions, entity definitions, schedules and shared business rules used by the self-hosted backend; it is not the production hosting platform.

For the decision motor's history, known incidents, evidence levels and deployment limitations, see [docs/HISTORICO_MOTOR_DECISAO_V6SIA.md](docs/HISTORICO_MOTOR_DECISAO_V6SIA.md).

## Requirements

- Node.js and the package manager/lockfile configured for the checkout.
- Deno 2.x for the backend.
- PostgreSQL and the required environment variables for a fully connected local backend.

## Run locally

Install frontend dependencies using the lockfile, then start Vite from the project root:

```bash
npm ci
npm run dev
```

In another terminal, start the Deno backend:

```bash
cd server
deno task dev
```

The backend import map in `server/deno.json` redirects the compatibility SDK to the self-hosted implementation. Local operation that uses Amazon integrations requires credentials and PostgreSQL configuration; tests must use mocks or isolated credentials and must not mutate a production account.

## Validation

- Frontend tests and build: use the scripts in `package.json` and `.github/workflows/ci.yml`.
- Backend and shared rules: run the Deno tests and checks listed in `.github/workflows/ci.yml`.
- The current execution ledger, motor status semantics, incidents, and outstanding validation are documented in the [V6SIA motor history](docs/HISTORICO_MOTOR_DECISAO_V6SIA.md).

## Production deployment

The deployment workflow is `.github/workflows/deploy.yml`. A push to `main` starts the Hostinger deployment workflow, but a push or successful frontend build alone does not prove the VPS is healthy. Confirm the workflow's post-deploy health output and the application status before reporting production success. Do not enable its optional Amazon automation input during code-only validation.

Configuration and secrets are managed in the Hostinger/GitHub environment. Never commit credentials or print secrets in logs. Do not run production migrations, deploys, or Amazon campaign mutations as part of local tests.
