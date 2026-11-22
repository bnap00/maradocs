// Small, self-contained HTML pages rendered by the Worker (password gate,
// sign-in prompt, 404, repository index). Inline CSS only, no external assets,
// light + dark themes matching the dashboard's design tokens.

import { escapeHtml } from "./http.js";

/** CSP for Worker-rendered pages: no scripts at all, forms post to self only. */
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; " +
  "frame-ancestors 'self'; base-uri 'none'";

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfc;--surface:#fff;--border:#e5e5ea;--control-border:#8b8b96;--text:#17171a;--text-2:#4f4f58;
--muted:#6b6b75;--accent:#5b5bd6;--accent-solid:#5b5bd6;--accent-solid-hover:#4d4dc6;--accent-fg:#fff;--focus:#5b5bd6;
--danger:#cd2b31;--danger-bg:#fff0f0;--danger-border:#f6c6c7;--radius:12px;--radius-control:8px;
--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0e0f11;--surface:#151619;--border:#26272d;--control-border:#6b6d76;--text:#ececef;
--text-2:#b2b2ba;--muted:#8d8d97;--accent:#7272ea;--accent-solid:#5b5bd6;--accent-solid-hover:#6262de;--accent-fg:#fff;
--focus:#9090f5;--danger:#ff6b70;--danger-bg:rgba(255,107,112,.1);--danger-border:rgba(255,107,112,.3)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);
color:var(--text);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:400px;background:var(--surface);border:1px solid var(--border);
border-radius:var(--radius);padding:32px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px rgba(16,24,40,.06)}
.wide{max-width:720px}
.icon{width:40px;height:40px;border-radius:var(--radius-control);display:grid;place-items:center;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)}
h1{font-size:18px;line-height:1.3;font-weight:600;margin:16px 0 6px;letter-spacing:-.01em}
p{margin:0 0 20px;color:var(--text-2);font-size:14px}
code{font-family:var(--mono);font-size:12.5px;color:var(--text);background:color-mix(in srgb,var(--muted) 12%,transparent);padding:1px 6px;border-radius:4px}
label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
input{width:100%;height:36px;padding:0 10px;border-radius:var(--radius-control);border:1px solid var(--control-border);background:var(--surface);color:var(--text);font:inherit;outline:2px solid transparent}
input:focus{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
input:focus-visible{outline:2px solid transparent;outline-offset:0}
.btn{display:inline-flex;justify-content:center;align-items:center;gap:8px;width:100%;margin-top:14px;height:36px;padding:0 14px;border:0;
border-radius:var(--radius-control);background:var(--accent-solid);color:var(--accent-fg);font:500 14px var(--font);cursor:pointer;text-decoration:none}
.btn:hover{background:var(--accent-solid-hover)}
.error{margin-top:14px;padding:10px 12px;border-radius:var(--radius-control);border:1px solid var(--danger-border);background:var(--danger-bg);color:var(--danger);font-size:13px}
.brand{margin-top:24px;font-size:12px;color:var(--muted);text-align:center}
ul{list-style:none;margin:0;padding:0}
li{border-top:1px solid var(--border)}
li a{display:flex;justify-content:space-between;gap:12px;padding:14px 4px;color:var(--text);text-decoration:none}
li a:hover .t{color:var(--accent)}
.t{font-weight:600}.s{font-family:var(--mono);font-size:12px;color:var(--muted)}
.empty{padding:20px 4px;color:var(--muted);border-top:1px solid var(--border)}
@media (forced-colors:active){.btn{border:1px solid ButtonText}}
`;

const ICONS = {
  lock: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  shield: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  search: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  book: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z"/><path d="M6.5 17H20v5H6.5a2.5 2.5 0 0 1 0-5z"/></svg>`,
};

function layout(title: string, body: string, wide = false): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main class="card${wide ? " wide" : ""}">${body}<div class="brand">Published with MaraDocs</div></main></body></html>`;
}

export function passwordGatePage(opts: { repo: string; doc: string; next: string; error?: string }): string {
  const target = `${opts.repo}/${opts.doc}`;
  const action = `/r/${encodeURIComponent(opts.repo)}/${encodeURIComponent(opts.doc)}/__unlock`;
  return layout(
    `Protected · ${target}`,
    `<div class="icon">${ICONS.lock}</div>
<h1>This report is password protected</h1>
<p>Enter the password to view <code>${escapeHtml(target)}</code>.</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="next" value="${escapeHtml(opts.next)}">
<label for="password">Password</label>
<input id="password" type="password" name="password" autocomplete="current-password" autofocus required maxlength="256">
<button class="btn" type="submit">Unlock</button>
${opts.error ? `<div class="error" role="alert">${escapeHtml(opts.error)}</div>` : ""}
</form>`,
  );
}

export function signInPage(opts: { repo: string; doc: string; next: string; dashboardOrigin?: string | null }): string {
  const target = `${opts.repo}/${opts.doc}`;
  const href = `${opts.dashboardOrigin ?? ""}/dashboard/login?next=${encodeURIComponent(opts.next)}`;
  return layout(
    `Private · ${target}`,
    `<div class="icon">${ICONS.shield}</div>
<h1>This report is private</h1>
<p>Sign in to MaraDocs with the account that owns <code>${escapeHtml(target)}</code> to view it.</p>
<a class="btn" href="${escapeHtml(href)}">Sign in</a>`,
  );
}

export function notFoundPage(message = "The page you are looking for does not exist."): string {
  return errorPage("Not found", message);
}

export function errorPage(title: string, message: string): string {
  return layout(
    title,
    `<div class="icon">${ICONS.search}</div>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>`,
  );
}

export function repoIndexPage(
  repo: { slug: string; name: string; description: string | null },
  docs: { slug: string; title: string }[],
): string {
  const items = docs
    .map(
      (d) =>
        `<li><a href="/r/${encodeURIComponent(repo.slug)}/${encodeURIComponent(d.slug)}/"><span class="t">${escapeHtml(d.title)}</span><span class="s">${escapeHtml(d.slug)}</span></a></li>`,
    )
    .join("");
  return layout(
    repo.name,
    `<div class="icon">${ICONS.book}</div>
<h1>${escapeHtml(repo.name)}</h1>
${repo.description ? `<p>${escapeHtml(repo.description)}</p>` : `<p>Published reports in <code>${escapeHtml(repo.slug)}</code>.</p>`}
${items ? `<ul>${items}</ul>` : `<div class="empty">No public documents yet.</div>`}`,
    true,
  );
}

export function dashboardMissingPage(): string {
  return layout(
    "MaraDocs",
    `<div class="icon">${ICONS.book}</div>
<h1>Dashboard not built</h1>
<p>The MaraDocs API is running, but the dashboard assets were not found. Build them with
<code>npm run build</code> and redeploy (<code>npm run deploy</code>).</p>
<p>The API is available at <code>/api/v1</code> and health at <code>/health</code>.</p>`,
  );
}
