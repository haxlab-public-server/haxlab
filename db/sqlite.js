const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function createSqliteDatabase(filePath = path.join(__dirname, 'haxchill.sqlite')) {
    const database = new DatabaseSync(filePath);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');

    const initStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS player_stats (
            auth TEXT PRIMARY KEY,
            player_name TEXT NOT NULL,
            games INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            goals INTEGER NOT NULL DEFAULT 0,
            assists INTEGER NOT NULL DEFAULT 0,
            own_goals INTEGER NOT NULL DEFAULT 0,
            clean_sheets INTEGER NOT NULL DEFAULT 0,
            playtime INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const reportStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS game_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const mastersStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS masters (
            auth TEXT PRIMARY KEY,
            added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const adminsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS admins (
            auth TEXT PRIMARY KEY,
            player_name TEXT NOT NULL,
            added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // VIPs get no extra permissions (no command role check treats them
    // specially) — this is purely cosmetic, a chat prefix. Same DB-backed
    // pattern as admins/masters rather than a runtime-only list, so it
    // survives a bot restart.
    const vipsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS vips (
            auth TEXT PRIMARY KEY,
            player_name TEXT NOT NULL,
            added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Links a HaxBall auth to the Discord user ID a player provided via the
    // in-game !discord command — lets Discord-side commands (e.g. !stats with
    // no name) know which HaxBall player is talking, without asking them to
    // type their own in-game name.
    const discordLinksStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS discord_links (
            auth TEXT PRIMARY KEY,
            discord_id TEXT NOT NULL,
            linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // HaxBall's own ban (the checkbox on the native client kick dialog) only
    // blocks the current CONNECTION — it can't stop someone who isn't in the
    // room right now, and doesn't survive them reconnecting on a fresh
    // connection with the same auth. This is a second, independent ban list
    // keyed by auth, enforced at room.onPlayerJoin regardless of whether the
    // target is online when the ban is issued.
    const authBansStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS auth_bans (
            auth TEXT PRIMARY KEY,
            player_name TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            banned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    function init() {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        initStatement.run();
        reportStatement.run();
        mastersStatement.run();
        adminsStatement.run();
        vipsStatement.run();
        discordLinksStatement.run();
        authBansStatement.run();
        return true;
    }

    function computeWinrate(games, wins) {
        return ((100 * wins) / (games || 1)).toFixed(1) + '%';
    }

    // Field order matches HaxStatistics's constructor — printPlayerStats()
    // displays stats in object-insertion order.
    function rowToStats(row) {
        if (!row) return null;
        return {
            playerName: row.player_name,
            games: row.games,
            wins: row.wins,
            winrate: computeWinrate(row.games, row.wins),
            playtime: row.playtime,
            goals: row.goals,
            assists: row.assists,
            CS: row.clean_sheets,
            ownGoals: row.own_goals,
        };
    }

    const PLAYER_STATS_COLUMNS = 'player_name, games, wins, goals, assists, own_goals, clean_sheets, playtime';

    function getPlayerStats(auth) {
        const row = database
            .prepare(`SELECT ${PLAYER_STATS_COLUMNS} FROM player_stats WHERE auth = ?`)
            .get(auth);
        return rowToStats(row);
    }

    // Case-insensitive exact match on the display name — used by the Discord
    // stats command, where players are looked up by name, not auth. player_name
    // isn't unique (a name can be reused via !rename), so this returns whichever
    // row matches first; good enough for a chat lookup, not a precise identity.
    function getPlayerStatsByName(playerName) {
        const row = database
            .prepare(`SELECT ${PLAYER_STATS_COLUMNS} FROM player_stats WHERE player_name = ? COLLATE NOCASE LIMIT 1`)
            .get(playerName);
        return rowToStats(row);
    }

    function savePlayerStats(auth, stats) {
        database
            .prepare(
                `INSERT INTO player_stats
                    (auth, player_name, games, wins, goals, assists, own_goals, clean_sheets, playtime, updated_at)
                 VALUES
                    (@auth, @playerName, @games, @wins, @goals, @assists, @ownGoals, @CS, @playtime, CURRENT_TIMESTAMP)
                 ON CONFLICT(auth) DO UPDATE SET
                    player_name = excluded.player_name,
                    games = excluded.games,
                    wins = excluded.wins,
                    goals = excluded.goals,
                    assists = excluded.assists,
                    own_goals = excluded.own_goals,
                    clean_sheets = excluded.clean_sheets,
                    playtime = excluded.playtime,
                    updated_at = CURRENT_TIMESTAMP`
            )
            .run({
                auth,
                playerName: stats.playerName ?? '',
                games: stats.games ?? 0,
                wins: stats.wins ?? 0,
                goals: stats.goals ?? 0,
                assists: stats.assists ?? 0,
                ownGoals: stats.ownGoals ?? 0,
                CS: stats.CS ?? 0,
                playtime: stats.playtime ?? 0,
            });
        return stats;
    }

    // statKey -> column name, kept as an explicit allowlist rather than
    // interpolating the key into SQL directly.
    const LEADERBOARD_COLUMNS = {
        games: 'games',
        wins: 'wins',
        goals: 'goals',
        assists: 'assists',
        CS: 'clean_sheets',
        playtime: 'playtime',
    };

    function getLeaderboard(statKey, limit) {
        const column = LEADERBOARD_COLUMNS[statKey];
        if (!column) throw new Error(`getLeaderboard: unknown statKey "${statKey}"`);

        const rows = database
            .prepare(`SELECT player_name, ${column} AS value FROM player_stats ORDER BY ${column} DESC LIMIT ?`)
            .all(limit);

        return rows.map((row) => ({ playerName: row.player_name, value: row.value }));
    }

    // Masters are configured out-of-band (see scripts/add-master.js), never by
    // an in-game command — there is no "promote to master" bot command.
    function getMasters() {
        return database.prepare('SELECT auth FROM masters').all().map((row) => row.auth);
    }

    function addMaster(auth) {
        database.prepare('INSERT INTO masters (auth) VALUES (?) ON CONFLICT(auth) DO NOTHING').run(auth);
    }

    function getAdmins() {
        return database
            .prepare('SELECT auth, player_name AS playerName FROM admins')
            .all();
    }

    function addAdmin(auth, playerName) {
        database
            .prepare(
                `INSERT INTO admins (auth, player_name) VALUES (?, ?)
                 ON CONFLICT(auth) DO UPDATE SET player_name = excluded.player_name`
            )
            .run(auth, playerName);
    }

    function removeAdmin(auth) {
        database.prepare('DELETE FROM admins WHERE auth = ?').run(auth);
    }

    function getVips() {
        return database
            .prepare('SELECT auth, player_name AS playerName FROM vips')
            .all();
    }

    function addVip(auth, playerName) {
        database
            .prepare(
                `INSERT INTO vips (auth, player_name) VALUES (?, ?)
                 ON CONFLICT(auth) DO UPDATE SET player_name = excluded.player_name`
            )
            .run(auth, playerName);
    }

    function removeVip(auth) {
        database.prepare('DELETE FROM vips WHERE auth = ?').run(auth);
    }

    // A player may relink to a different Discord account (e.g. a typo the
    // first time), so this upserts rather than rejecting an existing link.
    function linkDiscordId(auth, discordId) {
        database
            .prepare(
                `INSERT INTO discord_links (auth, discord_id, linked_at) VALUES (@auth, @discordId, CURRENT_TIMESTAMP)
                 ON CONFLICT(auth) DO UPDATE SET discord_id = excluded.discord_id, linked_at = CURRENT_TIMESTAMP`
            )
            .run({ auth, discordId });
    }

    function getDiscordIdByAuth(auth) {
        const row = database.prepare('SELECT discord_id FROM discord_links WHERE auth = ?').get(auth);
        return row ? row.discord_id : null;
    }

    // Not unique-constrained: two players could type the same ID (typo or
    // otherwise). Returns whichever linked first — good enough for looking up
    // "who is this Discord user in-game", not an identity guarantee.
    function getAuthByDiscordId(discordId) {
        const row = database.prepare('SELECT auth FROM discord_links WHERE discord_id = ? ORDER BY linked_at ASC LIMIT 1').get(discordId);
        return row ? row.auth : null;
    }

    function banAuth(auth, playerName, reason) {
        database
            .prepare(
                `INSERT INTO auth_bans (auth, player_name, reason, banned_at)
                 VALUES (@auth, @playerName, @reason, CURRENT_TIMESTAMP)
                 ON CONFLICT(auth) DO UPDATE SET
                    player_name = excluded.player_name,
                    reason = excluded.reason,
                    banned_at = CURRENT_TIMESTAMP`
            )
            .run({ auth, playerName: playerName ?? '', reason: reason ?? '' });
    }

    function unbanAuth(auth) {
        database.prepare('DELETE FROM auth_bans WHERE auth = ?').run(auth);
    }

    function getAuthBan(auth) {
        return database
            .prepare('SELECT auth, player_name AS playerName, reason FROM auth_bans WHERE auth = ?')
            .get(auth) ?? null;
    }

    function getAuthBans() {
        return database
            .prepare('SELECT auth, player_name AS playerName, reason FROM auth_bans ORDER BY banned_at DESC')
            .all();
    }

    // VACUUM INTO takes a consistent, atomic snapshot even while the DB is
    // open and being written to (unlike copying the .sqlite file directly,
    // which risks grabbing it mid-write since it's in WAL mode). destPath is
    // never user input — always an internally-generated backup filename.
    function backup(destPath) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const escaped = destPath.replace(/'/g, "''");
        database.exec(`VACUUM INTO '${escaped}'`);
    }

    function saveGameReport(report) {
        const payload = JSON.stringify(report);
        database
            .prepare('INSERT INTO game_reports (report_id, payload) VALUES (?, ?)')
            .run(report.reportId ?? '', payload);
        return report;
    }

    function close() {
        database.close();
    }

    return {
        init,
        getPlayerStats,
        getPlayerStatsByName,
        savePlayerStats,
        getLeaderboard,
        getMasters,
        addMaster,
        getAdmins,
        addAdmin,
        removeAdmin,
        getVips,
        addVip,
        removeVip,
        linkDiscordId,
        getDiscordIdByAuth,
        getAuthByDiscordId,
        banAuth,
        unbanAuth,
        getAuthBan,
        getAuthBans,
        backup,
        saveGameReport,
        close,
    };
}

module.exports = {
    createSqliteDatabase,
};
