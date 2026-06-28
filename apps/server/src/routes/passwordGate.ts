// Slugs are validated to [a-z0-9-] by slugSchema before being stored, so
// they cannot contain HTML metacharacters. Escaping is belt-and-suspenders.
function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Minimal, self-contained password gate page (no external assets). */
export function passwordGateHtml(opts: {
  repo: string;
  doc: string;
  error?: boolean;
}): string {
  const repo = escHtml(opts.repo);
  const doc = escHtml(opts.doc);
  const title = `${repo}/${doc}`;
  const action = `/r/${repo}/${doc}/__unlock`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Protected · ${title}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: radial-gradient(1200px 600px at 50% -10%, #1e293b, #0b1120);
    color: #e2e8f0;
  }
  .card {
    width: min(92vw, 380px); padding: 32px; border-radius: 16px;
    background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(148,163,184,.18);
    box-shadow: 0 20px 60px rgba(0,0,0,.45); backdrop-filter: blur(8px);
  }
  .lock { font-size: 28px; }
  h1 { font-size: 18px; margin: 12px 0 4px; }
  p { margin: 0 0 20px; color: #94a3b8; font-size: 13px; }
  code { color: #cbd5e1; }
  input {
    width: 100%; padding: 12px 14px; border-radius: 10px; font-size: 14px;
    border: 1px solid rgba(148,163,184,.25); background: rgba(2,6,23,.6); color: #e2e8f0;
  }
  input:focus { outline: 2px solid #6366f1; border-color: transparent; }
  button {
    margin-top: 14px; width: 100%; padding: 12px; border: 0; border-radius: 10px;
    background: linear-gradient(135deg,#6366f1,#8b5cf6); color: white; font-weight: 600;
    font-size: 14px; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  .error { color: #fca5a5; font-size: 13px; margin-top: 12px; }
</style>
</head>
<body>
  <form class="card" method="post" action="${action}">
    <div class="lock">🔒</div>
    <h1>This report is protected</h1>
    <p>Enter the password to view <code>${title}</code>.</p>
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Unlock</button>
    ${opts.error ? '<div class="error">Incorrect password. Try again.</div>' : ""}
  </form>
</body>
</html>`;
}

export function signInHtml(opts: { repo: string; doc: string }): string {
  const title = `${escHtml(opts.repo)}/${escHtml(opts.doc)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Private · ${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font-family: ui-sans-serif, system-ui, sans-serif;
    background: radial-gradient(1200px 600px at 50% -10%, #1e293b, #0b1120); color:#e2e8f0; }
  .card { width:min(92vw,380px); padding:32px; border-radius:16px; text-align:center;
    background: rgba(15,23,42,.7); border:1px solid rgba(148,163,184,.18); }
  h1 { font-size:18px; } p { color:#94a3b8; font-size:13px; }
  a { display:inline-block; margin-top:12px; padding:10px 18px; border-radius:10px;
    background: linear-gradient(135deg,#6366f1,#8b5cf6); color:#fff; text-decoration:none; font-weight:600; }
</style></head>
<body><div class="card">
  <div style="font-size:28px">🔐</div>
  <h1>This report is private</h1>
  <p>You need to sign in to view <code>${title}</code>.</p>
  <a href="/dashboard">Sign in</a>
</div></body></html>`;
}
