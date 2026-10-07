# SESSION: infra

**Trigger**: "Set up infrastructure" or "Update infra: `<change>`"

OpenTofu, Docker, and CI/CD changes — always validated, human-reviewed before apply.

## Workflow

1. **READ** — Review `docs/architecture.md` Sections 8-9 for IaC and CI/CD specs
2. **CREATE/UPDATE** — OpenTofu configs in `infra/`, Docker configs in `docker/`, GitHub Actions in `.github/workflows/`
3. **VALIDATE** — `cd infra && tofu validate` for OpenTofu; validate Docker build: `docker build -f docker/Dockerfile .`
4. **DOCUMENT** — Update `README.md` (§ Deployment Options) if deployment steps changed
