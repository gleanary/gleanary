# ADR-005: Per-Session Chat Model Selection

**Date**: 2026-04
**Status**: Accepted

## Context

The knowledge chat feature uses Claude models for response synthesis. Multiple Claude models are available at different cost/capability trade-offs (Haiku 4.5, Sonnet 4.6, Opus 4.6). The question is at what granularity to expose model selection: globally (one setting for all chats), per-user, or per-session.

## Decision

Store the selected model on `chat_sessions.model` (default: `claude-sonnet-4-6`). Users choose a model when creating a new chat session; the choice is immutable for that session's lifetime.

## Rationale

1. **Different sessions have different profiles**: A quick factual question benefits from Haiku (fast, cheap), while deep synthesis across many highlights warrants Opus. Locking a user into a single global model means either paying for Opus on all queries or getting Haiku quality on complex ones.

2. **Consistency within a session**: Switching models mid-conversation would cause inconsistencies in response style, token budget assumptions, and context window sizing. Binding the model to the session ensures all turns use the same context window and budget.

3. **Token budgets are model-relative**: Context window sizes differ significantly between models. Budgets are expressed as percentages of the model's context window (`contextWindowTokens`), computed at request time. This means the same percentage allocations apply correctly to whichever model was selected for the session.

4. **Utility calls are model-independent**: Keyword extraction (for FTS retrieval) and auto-title generation are always performed with Haiku regardless of the session model. These are short, structured tasks where cost matters more than quality.

5. **No multi-user implications**: The app is single-user. Per-session storage has no fan-out risk.

## Consequences

- `chat_sessions` table has a `model` column (text, not null, default `claude-sonnet-4-6`).
- The new chat UI (`/chat/new`) exposes a model selector. The value is written once at session creation.
- Context assembly in `src/lib/chat-retrieval.ts` reads `session.model` to determine context window size and computes token budgets as percentages of that window.
- Utility calls (keyword extraction, title generation) in the chat route hardcode Haiku regardless of `session.model`.
