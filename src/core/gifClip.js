/*
 * !gif (commands/player.js) — clips roughly the last 10 seconds of the
 * match around the moment the command was used, rendered by a separately
 * hosted HaxClip instance (github.com/Dani-404/HaxClip, forked to a 10s
 * window instead of its default 15s — see that fork's own Queue.js) and
 * posted straight to a dedicated Discord channel. We never see the GIF
 * bytes ourselves; HaxClip posts the finished result directly.
 *
 * Runs entirely in THIS page (the same realm as the rest of entry.js,
 * which HBInit() already gave native fetch/WebSocket/Blob — no bridging
 * to the Node orchestrator needed, same reasoning as HaxClip's own
 * reference room script talking to itself over a raw WebSocket).
 *
 * Two Discord webhooks, both plain HTTPS POSTs (no bot/gateway involved):
 *   - uploadWebhookUrl: temporary home for the raw .hbr2 replay so HaxClip
 *     has a URL to fetch it from (Discord's own CDN, not a file server we'd
 *     have to run ourselves).
 *   - resultWebhookId/resultWebhookToken: handed to HaxClip itself at
 *     connect time — it posts the finished GIF there directly once
 *     rendering completes, entirely on its own.
 *
 * One upload per match (not per clip request) — uploadReplay() is called
 * once in onGameStop with the match's own recording buffer; every queued
 * !gif request from that same match reuses the resulting URL via separate
 * sendClipRequest() calls, one per request (HaxClip needs its own
 * newClip message per clip — different requester/timestamp each time).
 */
module.exports = function createGifClip({
    haxclipWsUrl,
    haxclipApiKey,
    uploadWebhookUrl,
    resultWebhookId,
    resultWebhookToken,
}) {
    const enabled = Boolean(haxclipWsUrl && haxclipApiKey && uploadWebhookUrl && resultWebhookId && resultWebhookToken);
    let socket = null;
    let connected = false;
    // 5s reconnect delay — HaxClip runs on a separate box (RUVDS) we don't
    // control the uptime of from here; a brief restart there shouldn't
    // need a room restart to recover from.
    const RECONNECT_DELAY_MS = 5000;

    function connect() {
        if (!enabled) return;
        socket = new WebSocket(`${haxclipWsUrl}/?key=${haxclipApiKey}&&webHook=${resultWebhookId}/${resultWebhookToken}`);
        socket.addEventListener('open', () => {
            connected = true;
        });
        socket.addEventListener('close', () => {
            connected = false;
            setTimeout(connect, RECONNECT_DELAY_MS);
        });
        socket.addEventListener('error', (err) => {
            console.error('[gifClip] socket error:', err?.message || err);
        });
    }
    connect();

    // Uploads the match's own replay buffer to get a public URL HaxClip can
    // fetch from — returns null (never throws) on any failure, since a
    // failed upload just means no clips get processed this match, not
    // something that should block the rest of onGameStop.
    async function uploadReplay(buffer, filename) {
        if (!enabled) return null;
        try {
            const form = new FormData();
            form.append('file', new Blob([buffer]), filename);
            const response = await fetch(uploadWebhookUrl, { method: 'POST', body: form });
            const data = await response.json();
            const url = data?.attachments?.[0]?.url;
            if (!url) {
                console.error('[gifClip] upload did not return an attachment URL:', JSON.stringify(data));
                return null;
            }
            // Discord CDN URLs carry auth/expiry query params after the
            // real filename — HaxClip's own queue rejects anything not
            // literally ending in ".hbr2" (see its QueueManager.js).
            return url.split('?')[0];
        } catch (err) {
            console.error('[gifClip] replay upload failed:', err?.message || err);
            return null;
        }
    }

    function sendClipRequest(replayUrl, playerName, playerId, matchTimeSeconds) {
        if (!enabled) return;
        if (!connected || socket.readyState !== WebSocket.OPEN) {
            console.error('[gifClip] HaxClip not connected, dropping clip request for', playerName);
            return;
        }
        socket.send(JSON.stringify({
            key: 'newClip',
            data: {
                url: replayUrl,
                byUser: { username: playerName, id: playerId },
                time: Math.round(matchTimeSeconds),
            },
        }));
    }

    return { enabled, uploadReplay, sendClipRequest };
};
