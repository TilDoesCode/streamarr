# Install Streamarr on Komodo (with an existing Jellyfin)

This is the easy path if you **already run [Komodo](https://komo.do)** and **already
have a Jellyfin server**. There are no build steps and nothing to compile. You will:

1. Create one Komodo stack that runs the Streamarr Core Server.
2. Add the Streamarr plugin to your existing Jellyfin from a URL.
3. Point the plugin at the Core Server and turn it on.

Total time is a few minutes. Everything below is copy‑paste.

> **Security note.** Streamarr serves plain HTTP and must not face the public internet.
> Keep it on your home LAN or behind your existing reverse proxy, exactly like you
> already do with Jellyfin.

---

## Step 1 — Create the Streamarr stack in Komodo

1. In Komodo, go to **Stacks → + New Stack**. Give it a name such as `streamarr`.
2. Set the stack to **UI Defined** (paste the compose file below) — or point it at
   `deploy/compose.komodo.yml` from this repository if you prefer a Git‑backed stack.
3. Paste this into the compose file box:

   ```yaml
   name: streamarr

   services:
     streamarr:
       image: "${STREAMARR_IMAGE:-ghcr.io/tildoescode/streamarr:latest}"
       init: true
       read_only: true
       cap_drop:
         - ALL
       security_opt:
         - no-new-privileges:true
       ports:
         - "${STREAMARR_BIND_ADDRESS:-0.0.0.0}:${STREAMARR_PORT:-8080}:8080"
       environment:
         ASPNETCORE_ENVIRONMENT: Production
         Streamarr__ApiKey: "${STREAMARR_API_KEY:?Set STREAMARR_API_KEY in the environment}"
         Streamarr__Admin__Username: "${STREAMARR_ADMIN_USERNAME:-admin}"
         Streamarr__Admin__Password: "${STREAMARR_ADMIN_PASSWORD:?Set STREAMARR_ADMIN_PASSWORD in the environment}"
         Streamarr__ConnectionString: "Data Source=/app/data/streamarr.db"
         Streamarr__DataProtectionKeysPath: /app/keys
       volumes:
         - streamarr-data:/app/data
         - streamarr-keys:/app/keys
       tmpfs:
         - /tmp:rw,noexec,nosuid,nodev,size=64m
       healthcheck:
         test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8080/api/v1/health?deep=false"]
         interval: 15s
         timeout: 5s
         retries: 5
         start_period: 20s
       restart: unless-stopped

   volumes:
     streamarr-data:
     streamarr-keys:
   ```

4. In the stack's **Environment** box, paste these two lines and replace each value
   with a fresh random secret (keep them different):

   ```
   STREAMARR_API_KEY=REPLACE_WITH_A_LONG_RANDOM_VALUE
   STREAMARR_ADMIN_PASSWORD=REPLACE_WITH_A_DIFFERENT_LONG_RANDOM_VALUE
   ```

   Need to generate them? On any machine run `openssl rand -base64 32` twice, or use a
   password manager. The API key is what Jellyfin uses; the admin password is for the
   Streamarr Management UI. Komodo keeps these values as stack secrets.

5. Click **Deploy**. Wait until Komodo shows the `streamarr` container as **healthy**.

That's it for the server. Open `http://<your-docker-host-ip>:8080` in a browser to
reach the Streamarr Management UI (log in with username `admin` and the admin password
you set).

**Optional tweaks** (add more lines to the Environment box only if you want them):

| Variable | Default | Use it to… |
|---|---|---|
| `STREAMARR_IMAGE` | `…/streamarr:latest` | Pin a specific version, e.g. `ghcr.io/tildoescode/streamarr:0.3.0` |
| `STREAMARR_BIND_ADDRESS` | `0.0.0.0` | Lock the port to one LAN address, e.g. `192.168.1.20` |
| `STREAMARR_PORT` | `8080` | Publish on a different host port |

---

## Step 2 — Add the plugin to your existing Jellyfin

You do **not** need to copy any files. Streamarr publishes a Jellyfin plugin catalog.

1. In Jellyfin, go to **Dashboard → Plugins → Repositories → +** (Add).
2. Enter:
   - **Repository Name:** `Streamarr`
   - **Repository URL:**
     `https://raw.githubusercontent.com/TilDoesCode/streamarr/main/manifest.json`
3. Save, then open **Dashboard → Plugins → Catalog**. Under it you'll find
   **Streamarr** — click it and press **Install**.
4. **Restart Jellyfin** when it asks (in Komodo, just redeploy/restart your Jellyfin
   stack).

Jellyfin will keep the plugin up to date from this repository going forward.

> The plugin targets **Jellyfin 10.11.11**. If the catalog shows no installable
> version, your Jellyfin is on a different release — see
> [`jellyfin-compatibility.md`](jellyfin-compatibility.md).

<details>
<summary>Prefer to install by hand instead of from the catalog?</summary>

Download `streamarr-jellyfin-<version>.zip` from the
[latest release](https://github.com/TilDoesCode/streamarr/releases/latest), and copy
its contents into `<jellyfin-config>/plugins/Streamarr/` (create the folder). The
directory must be writable by Jellyfin. Restart Jellyfin. Do not mix plugin and Core
Server versions.
</details>

---

## Step 3 — Connect the plugin to the Core Server

1. In Jellyfin, open **Dashboard → Plugins → Streamarr**.
2. Fill in:
   - **Core Server URL:** `http://<your-docker-host-ip>:8080`
     (the IP of the machine where the Komodo `streamarr` stack runs — the same IP you
     used to open the Management UI).
   - **API key:** the exact `STREAMARR_API_KEY` value you set in Step 1.
3. Click **Test connection**. It should succeed. A wrong key fails the test even when
   the server is up.
4. Enable **search interception** and save.

If Jellyfin and Streamarr run on the **same Docker host** and you would rather keep the
traffic off the LAN, put both on a shared Docker network and use
`http://streamarr:8080` as the Core Server URL instead — but the host‑IP URL above is
the simplest and works in every layout.

---

## Step 4 — Add your sources and test

Open the Streamarr Management UI (`http://<your-docker-host-ip>:8080`) and configure,
in this order — each has a **Test** button:

1. **Usenet provider** — host, port, SSL, credentials, max connections.
2. **Indexer(s)** — a Newznab base URL + API key.
3. **TMDB API key** — under Settings (optional but recommended).
4. **Quality profile** — start from the default and tune later.

Before involving Jellyfin, use **Search / Debug → Resolve → Preview** and confirm a
video plays in the browser. That proves the whole pipeline works. Then search in
Jellyfin — Usenet results appear alongside your normal library and play through
Jellyfin's transcoding.

---

## Updating and backups

- **Streamarr Core:** in Komodo, redeploy the stack to pull the newest image (or pin
  `STREAMARR_IMAGE` to a version and bump it when you want).
- **Plugin:** Jellyfin auto‑updates it from the repository you added. Keep the plugin
  and Core Server on matching versions.
- **Back up** the `streamarr-data` and `streamarr-keys` volumes together while the
  stack is stopped — the database holds your encrypted provider/indexer secrets and the
  key volume is required to decrypt them.

The full non‑Komodo installation, reverse‑proxy, and backup reference lives in the
[repository README](../README.md).
