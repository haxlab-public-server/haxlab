/*
 * Cycles through a fixed, ordered list of announcement messages (see
 * core/announcementMessages.js), broadcasting the next one to the whole
 * room every intervalMs — plain round-robin, not shuffled, so they read in
 * the order they're written and loop back to the start once exhausted.
 */
module.exports = function createAnnouncements({
    room,
    messages,
    announcementColor,
    HaxNotification,
    intervalMs,
}) {
    let index = 0;

    function sendNextAnnouncement() {
        if (messages.length === 0) return;
        room.sendAnnouncement(messages[index], null, announcementColor, 'bold', HaxNotification.CHAT);
        index = (index + 1) % messages.length;
    }

    function start() {
        if (messages.length === 0) return;
        setInterval(sendNextAnnouncement, intervalMs);
    }

    return { start };
};
