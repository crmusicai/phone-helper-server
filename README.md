# Phone Helper — Server

Backend server for the Phone Helper remote-support apps (Client + Provider):
permanent Client ID registry, online/offline presence, session and WebRTC
signalling relay, two-way voice sessions.

## Run locally

```
npm install
PROVIDER_KEY=your-secret PORT=8080 npm start
```

Health check: `GET /health`

## Deploy free (Render, connected to this GitHub repo)

1. Open https://render.com/deploy?repo=REPO_URL (replace REPO_URL with this repo)
2. Sign in with GitHub, set `PROVIDER_KEY` to a secret word of your choice.
3. Create — Render builds and gives a public `https://…onrender.com` address.
   The apps use the WebSocket form of the same address: `wss://…onrender.com`

Note: on the free plan the server sleeps after ~15 minutes idle and wakes in
under a minute when an app connects (apps auto-reconnect). The client list is
stored in a local file and resets if the service is redeployed.
