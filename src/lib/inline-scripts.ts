/**
 * Inline bootstrap scripts injected into the document via `dangerouslySetInnerHTML`
 * in `src/app/layout.tsx`.
 *
 * These constants are the single source of the inline `<script>` bodies. They execute under
 * the CSP's `script-src 'unsafe-inline'` (see next.config.ts) — they are NOT hash-allowlisted:
 * sha256-pinning them proved impossible because Next.js hydrates via its own dynamic inline
 * scripts that can't be hashed, and any hash in `script-src` makes browsers ignore
 * `'unsafe-inline'` entirely. If a nonce-based CSP lands (tracked in
 * TECH_DEBT.md), these will need the per-request nonce applied where layout.tsx injects them.
 */

/**
 * Theme bootstrap: runs before first paint to prevent a flash of the wrong theme (FOUC).
 * Reads `appearance_mode` from localStorage and applies the `.dark` class, falling back to
 * the system `prefers-color-scheme` when the mode is `automatic`.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var m=localStorage.getItem('appearance_mode');if(m==='dark'||(m!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})()`;

/** Service worker registration for PWA installability. */
export const SERVICE_WORKER_SCRIPT = `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js')})}`;
