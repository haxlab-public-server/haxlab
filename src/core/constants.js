module.exports = {
    Team: { SPECTATORS: 0, RED: 1, BLUE: 2 },
    State: { PLAY: 0, PAUSE: 1, STOP: 2 },
    Role: { PLAYER: 0, VIP: 1, ADMIN_TEMP: 2, ADMIN_PERM: 3, MASTER: 4 },
    HaxNotification: { NONE: 0, CHAT: 1, MENTION: 2 },
    Situation: { STOP: 0, KICKOFF: 1, PLAY: 2, GOAL: 3 },
    // Top-3-in-a-stat chat prefixes (!trophy, see commands/trophies.js) —
    // just the stat-name fragment; the medal + rank ("🥇Топ-1 ") is prefixed
    // by utils.js's formatTrophyLabel() using the player's ACTUAL current
    // rank (1/2/3), never stored — see state.topPlayers. Shared between that
    // command and events/activity.js's chat prefix so the two never
    // disagree on what a trophy key displays as.
    Trophies: {
        goals: 'голов',
        assists: 'ассистов',
        cs: 'GK',
        wr: 'WR',
        pt: 'PT',
    },
    welcomeColor: 0xc4ff65,
    announcementColor: 0xffefd6,
    infoColor: 0xbebebe,
    privateMessageColor: 0xffc933,
    redColor: 0xff4c4c,
    blueColor: 0x62cbff,
    warningColor: 0xffa135,
    errorColor: 0xa40000,
    successColor: 0x75ff75,
    defaultColor: null,
    masterChatColor: 0xffd700,
    adminChatColor: 0x00bfff,
    vipChatColor: 0xc77dff,
};
