# SESSION: security-audit

**Trigger**: `"Security audit"` or `"Security review"`

Full codebase security scan. Run this at minimum once per phase, or after any module that handles external input (articles, feeds, highlights, search). These checks are also the canonical reference for the scoped SECURE steps in the module-build and feature sessions (checks 1–6, limited to changed files).

## Workflow

1. **XSS AUDIT**:
   - `grep -rn "dangerouslySetInnerHTML" src/` — list every instance
   - For each: trace the data source back. Verify it passes through `sanitizeArticleHtml()` before reaching the component
   - `grep -rn "innerHTML" src/` — should not exist outside React's `dangerouslySetInnerHTML`
   - Check that `src/lib/sanitize.ts` exists and DOMPurify config matches architecture.md §16.2
   - **FAIL if**: any unsanitized HTML rendering found

2. **SSRF AUDIT**:
   - `grep -rn "fetch(" src/` — list every server-side fetch
   - For each: verify the URL passes through `validateUrl()` before the fetch call
   - Check that `src/lib/url-validator.ts` exists and blocks private IPs, internal hosts
   - Verify fetch timeout is set (≤10s) and response size is limited (≤5MB)
   - **FAIL if**: any unvalidated URL fetch found

3. **INPUT VALIDATION AUDIT**:
   - List every file in `src/app/api/` that exports HTTP method handlers
   - For each handler: verify a Zod schema validation is the first operation
   - Check that error responses use proper status codes (422 for validation, not 400 or 500)
   - **FAIL if**: any API route handler lacks Zod validation

4. **SQL INJECTION AUDIT**:
   - `grep -rn "db\.\(run\|execute\|prepare\)" src/` — find any raw SQL execution
   - `grep -rn "sql\`" src/` — find Drizzle raw SQL template usage
   - For any raw SQL: verify all user inputs are parameterized, never string-interpolated
   - Check all FTS5 queries use `escapeFts5Query()`
   - **FAIL if**: any unparameterized user input in SQL

5. **SECRETS AUDIT**:
   - `grep -rn "console\.\(log\|info\|warn\|error\)" src/` — should be zero (use `logger` instead)
   - `grep -rn "apiKey\|api_key\|secret\|password\|token" src/` — review each match for hardcoded values
   - Verify `.env.example` exists and contains no real secret values
   - Verify `.gitignore` includes `.env`, `terraform.tfvars`, and `*.db`
   - Check that `ANTHROPIC_API_KEY` is only used server-side (never in client components)
   - **FAIL if**: any hardcoded secrets or `console.log` usage found

6. **DEPENDENCY AUDIT**:
   - `npm audit --audit-level=high` — report high and critical vulnerabilities
   - `npx depcheck` — flag unused dependencies (attack surface reduction)
   - Review `package.json` for any unnecessary dependencies
   - **FAIL if**: any high/critical vulnerabilities with available fix

7. **HEADERS AUDIT**:
   - Verify `docker/Caddyfile` includes all security headers from architecture.md §16.7
   - Check CSP policy matches what the app actually needs (no overly permissive `unsafe-eval`)
   - **FAIL if**: missing CSP, X-Frame-Options, or X-Content-Type-Options

## Output format

```
SECURITY AUDIT REPORT — [date]
═══════════════════════════════
1. XSS Prevention         ✅ PASS | ❌ FAIL — [details]
2. SSRF Prevention         ✅ PASS | ❌ FAIL — [details]
3. Input Validation        ✅ PASS | ❌ FAIL — [details]
4. SQL Injection           ✅ PASS | ❌ FAIL — [details]
5. Secrets Management      ✅ PASS | ❌ FAIL — [details]
6. Dependencies            ✅ PASS | ❌ FAIL — [details]
7. Security Headers        ✅ PASS | ❌ FAIL — [details]

OVERALL: X/7 passed
ACTION ITEMS: [list any fixes needed]
```

If any check fails, fix the issue immediately and re-run the failing check. Do not consider the audit complete until all 7 checks pass.
