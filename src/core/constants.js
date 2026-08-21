module.exports = {
    Team: { SPECTATORS: 0, RED: 1, BLUE: 2 },
    State: { PLAY: 0, PAUSE: 1, STOP: 2 },
    Role: { PLAYER: 0, VIP: 1, ADMIN_TEMP: 2, ADMIN_PERM: 3, HELPER: 4, MASTER: 5 },
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
        assists: 'ас-ов',
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
    // Personal-achievement announcements only (games milestone, VIP lottery
    // win, top-5 entry ping — requested 2026-08-16) — distinct from the
    // neutral announcementColor every routine round-outcome message already
    // uses, so a player's own accomplishment visually stands out from them.
    achievementColor: 0xffd166,
    defaultColor: null,
    masterChatColor: 0xffd700,
    adminChatColor: 0x00bfff,
    // Role above admin, below master (see scripts/add-master.js-style
    // grants — 2026-08-21, requested as "Хелпер"/[HLP]). Distinct from
    // both admin's cyan and master's gold so the prefix is unmistakable
    // in chat.
    helperChatColor: 0x5cff8f,
    vipChatColor: 0xc77dff,
};
