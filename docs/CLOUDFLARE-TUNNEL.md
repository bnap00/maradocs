# Local Deployment with Cloudflare Tunnel

Run MaraDocs on your laptop and expose it publicly — no VPS, no DNS config required.
Cloudflare Tunnel gives you a stable HTTPS URL that proxies to your local container.

## Option A: Temporary tunnel (no account, great for demos)

```bash
# 1. Start MaraDocs locally
docker compose up -d

# 2. Install cloudflared (Mac)
brew install cloudflare/cloudflare/cloudflared
# Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# 3. Start a temporary tunnel — prints a random trycloudflare.com URL
cloudflared tunnel --url http://localhost:8787
```

Copy the printed URL (e.g. `https://random-name.trycloudflare.com`) and set it as
`PUBLIC_BASE_URL` so publish responses return shareable links:

```env
# .env
PUBLIC_BASE_URL=https://random-name.trycloudflare.com
```

Restart the container to pick up the new env:
```bash
docker compose down && docker compose up -d
```

> **Note:** Temporary tunnels generate a new URL each time you run cloudflared.
> For a stable URL, use Option B.

## Option B: Persistent tunnel with a custom domain (free Cloudflare account)

```bash
# 1. Log in to Cloudflare
cloudflared tunnel login

# 2. Create a named tunnel
cloudflared tunnel create maradocs

# 3. Route your domain to the tunnel (domain must be on Cloudflare)
cloudflared tunnel route dns maradocs docs.yourdomain.com

# 4. Create the tunnel config
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml <<EOF
tunnel: maradocs
credentials-file: ~/.cloudflared/<tunnel-id>.json  # replace with path printed by 'cloudflared tunnel create'
ingress:
  - hostname: docs.yourdomain.com
    service: http://localhost:8787
  - service: http_status:404
EOF

# 5. Set PUBLIC_BASE_URL in your .env
# PUBLIC_BASE_URL=https://docs.yourdomain.com

# 6. Start MaraDocs + tunnel
docker compose up -d
cloudflared tunnel run maradocs
```

Your MaraDocs instance is now reachable at `https://docs.yourdomain.com` and
all published report URLs will use that domain.

## Running cloudflared as a service (auto-start on boot)

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```
