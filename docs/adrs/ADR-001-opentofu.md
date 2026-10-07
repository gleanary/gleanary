# ADR-001: OpenTofu for Infrastructure as Code

**Status**: Accepted
**Date**: 2026-03-01

## Context

We need an IaC tool to provision and manage a single OVH VPS, security group, and SSH key. Options considered: OpenTofu, Pulumi (TypeScript), Ansible, manual provisioning.

## Decision

Use OpenTofu (open-source Terraform fork) with the OVH provider, combined with cloud-init for server bootstrap.

## Rationale

- **Industry standard**: most widely adopted IaC tool, immediately recognizable to any engineering leader or platform engineer. Valuable for consulting portfolio.
- **Declarative with state**: `tofu plan` shows exactly what will change before apply. State file tracks what exists.
- **OVH provider**: official, mature, well-documented. Also available via OpenStack provider for lower-level resources.
- **Claude Code fluency**: generates clean HCL reliably.
- **Separation of concerns**: OpenTofu provisions infrastructure, cloud-init configures the server on first boot. No need for Ansible at single-server scale.
- **Open-source**: MPL-2.0 license, community-governed under Linux Foundation. No BSL licensing concerns.

## Alternatives Rejected

- **Pulumi (TypeScript)**: Would unify the stack under one language, but adds runtime complexity (Node.js needed for infra), is less recognizable to the target consulting audience, and offers no meaningful advantage for ~50 lines of config.
- **Ansible**: Procedural, best for config management across fleets. Overkill for one server. Cloud-init covers the bootstrap use case.
- **Manual / OVH CLI**: No reproducibility, no version control, not demonstrable.

## Consequences

- Must store state file securely (not in git if it contains sensitive outputs). Can use OVH S3-compatible Object Storage as remote backend later.
- Team members (or future self) need basic HCL knowledge to modify infra.
- Migration to Pulumi or another tool is trivial at this scale (~50 lines).
