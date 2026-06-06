// Minimal Nitro route — proves the server layer responds (slice 0). A real freshness/heartbeat
// endpoint (reading the worker's last-published cycle state) lands with the web slice (slice 8).
export default defineEventHandler(() => ({ ok: true }))
