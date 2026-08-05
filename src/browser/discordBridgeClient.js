/*
 * In-page stand-in for the discordBot IPC shim that used to live in
 * src/index.js. Same method names/shapes every src/core/* factory already
 * expects (this interface was ALREADY an indirection over a separate
 * process before this file existed — see core/discordProcess.js — so
 * nothing about the *shape* changes here, only where the indirection
 * physically starts: page -> Node orchestrator -> Discord child process,
 * instead of Node orchestrator -> Discord child process directly).
 *
 * Every method is fire-and-forget, matching every call site in src/core/*
 * (none of them ever await or use a return value — confirmed by inventory
 * before this migration) — window.__discordSend still returns a Promise
 * (it's backed by page.exposeFunction), it's just never awaited here,
 * exactly like the pre-migration shim never awaited its child.send() calls.
 */
function uint8ArrayToBase64(bytes) {
    // page.exposeFunction JSON-serializes its arguments — a raw Uint8Array
    // would arrive as a numeric-keyed plain object (correct but wasteful).
    // Base64 keeps a game recording (up to a few MB) as a single compact
    // string across the bridge instead.
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

// state/authArray are closed over (not passed per-call) so updateRoomStatus()
// keeps the same zero-argument shape every caller already uses — same reason
// the pre-migration shim captured them from its enclosing index.js scope.
function createBridgedDiscordBot({ state, authArray }) {
    return {
        init() {},
        sendLog(content) {
            window.__discordSend('log', { content });
        },
        sendReport(embedData) {
            window.__discordSend('report', { embedData });
        },
        sendRecording(buffer, filename) {
            window.__discordSend('recording', { bufferBase64: uint8ArrayToBase64(buffer), filename });
        },
        setRoomLink(url) {
            window.__discordSend('roomLink', { url });
        },
        sendPassword(password) {
            window.__discordSend('password', { password });
        },
        sendAdminCall(playerName) {
            window.__discordSend('adminCall', { playerName });
        },
        sendMentionAlert(speakerName, text) {
            window.__discordSend('mentionAlert', { speakerName, text });
        },
        sendVoteBanNotification({ targetName, durationMinutes, votesFor, votesAgainst, abstained }) {
            window.__discordSend('voteBanNotification', { targetName, durationMinutes, votesFor, votesAgainst, abstained });
        },
        updateRoomStatus() {
            window.__discordSend('roster', {
                players: state.playersAll.map((p) => ({ id: p.id, name: p.name, auth: authArray[p.id]?.[0] ?? null })),
            });
        },
    };
}

module.exports = { createBridgedDiscordBot };
