const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function createSqliteDatabase(filePath = path.join(__dirname, 'haxlab.sqlite')) {
    const database = new DatabaseSync(filePath);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');
    // The room process and the Discord process (see core/discordProcess.js)
    // now each hold their own connection to this same file. WAL allows that,
    // but two writes landing in the same instant would otherwise throw
    // SQLITE_BUSY immediately instead of just waiting the near-instant it
    // takes the other connection's transaction to commit.
    database.exec('PRAGMA busy_timeout = 5000');

    // balance/equipped_form/equipped_goal_animation are economy fields (see
    // addCoins/buyItem/setEquipped below) — added via the same idempotent
    // ALTER TABLE pattern as auth_bans.expires_at for DBs that predate them.
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
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            balance INTEGER NOT NULL DEFAULT 0,
            equipped_form TEXT,
            equipped_goal_animation TEXT
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
    // survives a bot restart. expires_at is nullable — NULL means a
    // permanent grant, same nullable-means-permanent convention as
    // auth_bans (see banAuth/getAuthBan below), except here a permanent
    // grant is still a normal, supported case, not just legacy data.
    const vipsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS vips (
            auth TEXT PRIMARY KEY,
            player_name TEXT NOT NULL,
            added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT
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

    // Telegram account linking (requested 2026-08-17, see core/telegram.js) —
    // same shape as discord_links, but two-way: a link can be INITIATED from
    // either side (the room via !telegram, or Telegram via /start), so a
    // pending code doesn't yet know both halves of the pair. Exactly one of
    // auth/telegram_chat_id is set at creation; redemption fills in the
    // other and upserts telegram_links.
    const telegramLinksStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_links (
            auth TEXT PRIMARY KEY,
            telegram_chat_id TEXT NOT NULL,
            linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
    const telegramLinkCodesStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_link_codes (
            code TEXT PRIMARY KEY,
            auth TEXT,
            telegram_chat_id TEXT,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // HaxBall's own ban (the checkbox on the native client kick dialog) only
    // blocks the current CONNECTION — it can't stop someone who isn't in the
    // room right now, and doesn't survive them reconnecting on a fresh
    // connection with the same auth. This is a second, independent ban list
    // keyed by auth, enforced at room.onPlayerJoin regardless of whether the
    // target is online when the ban is issued.
    // expires_at is nullable: NULL means a permanent ban (only ever set that
    // way by data predating the mandatory-duration requirement — every ban
    // issued through !ban/!banauth/`/banauth` now always sets a real expiry).
    const authBansStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS auth_bans (
            auth TEXT PRIMARY KEY,
            player_name TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            banned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT
        );
    `);

    // Per-(auth, command) restriction blocking a specific player from using a
    // specific self-service room command (currently 'voteban'/'report') —
    // see !restrictcmd/!unrestrictcmd (commands/master.js). Same nullable
    // expires_at = permanent convention as auth_bans, but keyed on the pair
    // since one player can be restricted from one command and not the other.
    const commandRestrictionsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS command_restrictions (
            auth TEXT NOT NULL,
            command TEXT NOT NULL,
            player_name TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            restricted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT,
            PRIMARY KEY (auth, command)
        );
    `);

    // Generic key/value store for small bits of bot state that need to survive
    // a restart but don't warrant their own table — e.g. the Discord status
    // message ID, so the bot edits the same message instead of leaving a stale
    // one (with a dead room link) behind every time the process restarts.
    // Also holds 'currentSeason' (see getCurrentSeason/closeSeason below) and
    // one 'seasonClosed:<N>' flag per season already closed, same
    // once-only-migration-guard idea as scripts/migrate-size-levels.js.
    const settingsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS bot_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    // A permanent, frozen snapshot of each closed season's top-3 (see
    // closeSeason below) — unlike player_stats' live games/wins/goals/...
    // (reset to 0 when a season closes), these rows are never touched again
    // once written, so a player who held rank 1-3 keeps that exact title
    // forever, independent of anything that happens in later seasons.
    // (season, category, rank) is the PK since exactly one player ever holds
    // a given rank in a given category in a given season.
    const seasonTrophiesStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS season_trophies (
            season INTEGER NOT NULL,
            category TEXT NOT NULL,
            rank INTEGER NOT NULL,
            auth TEXT NOT NULL,
            player_name TEXT NOT NULL,
            value REAL NOT NULL,
            PRIMARY KEY (season, category, rank)
        );
    `);

    // Which shop items (see core/shopItems.js) a player owns — separate from
    // which one is currently equipped (player_stats.equipped_form/
    // equipped_goal_animation), so buying something doesn't have to also
    // wear it, and switching back to a previously-bought item never re-charges.
    // level is only meaningful for the upgradeable 'small'/'big' size items
    // (see shopItems.js's `upgradeable` items) — every other item is always
    // level 1, bought once, done.
    const playerItemsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS player_items (
            auth TEXT NOT NULL,
            item_id TEXT NOT NULL,
            purchased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (auth, item_id)
        );
    `);

    // Player clubs (!clubcreate/!clubinvite/etc., see core/commands/club.js).
    // owner_auth is redundant with a club_members row (the owner is always
    // also a member), but kept as its own column since ownership checks
    // ("are you allowed to !clubkick/!clubcolor/etc.") happen far more often
    // than membership listing, and this avoids a join for every one of them.
    // color is nullable — NULL means "no custom color set", falls back to
    // the default chat color (see events/activity.js).
    const clubsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS clubs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            prefix TEXT NOT NULL,
            owner_auth TEXT NOT NULL,
            color INTEGER,
            slots INTEGER NOT NULL DEFAULT 5,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // auth is the PRIMARY KEY, not (club_id, auth) — a player can only ever
    // be in one club at a time, enforced directly by the schema rather than
    // just by application logic.
    const clubMembersStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS club_members (
            auth TEXT PRIMARY KEY,
            club_id INTEGER NOT NULL,
            player_name TEXT NOT NULL,
            joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Unlike club_members, a player CAN hold invites from more than one club
    // at once (they just can't accept more than one) — so this is keyed by
    // (club_id, auth), not auth alone. expires_at is mandatory (unlike
    // auth_bans' nullable one) — every club invite always expires, there is
    // no permanent-invite case.
    const clubInvitesStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS club_invites (
            club_id INTEGER NOT NULL,
            auth TEXT NOT NULL,
            invited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            PRIMARY KEY (club_id, auth)
        );
    `);

    // One row per ranked BFF match per player (see core/bff/matchFlow.js's
    // handlePlayersStop) — feeds !sf's "за последние N игр" trend line
    // (getRecentRatingDelta below). `delta` is stored already in DISPLAY
    // units (formatRatingDisplay's rescaled points, not raw openskill
    // ordinal) so a read never needs to know about that rescale at all.
    // Only ever appended to, never updated — no need to key it by auth,
    // an autoincrement id plus an index on (auth, id DESC) is enough for
    // the ORDER BY id DESC LIMIT ? read pattern this exists for (id, not
    // created_at — see getRecentRatingDelta's own comment on why).
    const ratingHistoryStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS rating_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            auth TEXT NOT NULL,
            delta REAL NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
    // !silence (main room only — see commands/player.js) — a per-VIEWER
    // chat filter, previously session-only (requested 2026-08-16: survive a
    // restart). One row per (viewer, target) pair; the pair IS the key, so
    // no separate id/timestamp is needed.
    const silencedPairsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS silenced_pairs (
            viewer_auth TEXT NOT NULL,
            target_auth TEXT NOT NULL,
            PRIMARY KEY (viewer_auth, target_auth)
        );
    `);
    // Pairwise match history (requested 2026-08-17, "!vs"/rivalry-hype/
    // same-day-rematch) — one row per unordered pair of auths, keyed with
    // auth_a < auth_b (lexicographic) so a pair is never stored twice under
    // swapped order; recordHeadToHead below normalizes on write,
    // getHeadToHead on read. Only tracks time spent on OPPOSING TEAMS
    // specifically (see recordHeadToHead's own doc comment) — two people
    // who only ever played AS teammates never get a row at all. `games` is
    // its own counter, NOT wins_a+wins_b — a draw increments it without
    // moving either win count.
    const headToHeadStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS head_to_head (
            auth_a TEXT NOT NULL,
            auth_b TEXT NOT NULL,
            games INTEGER NOT NULL DEFAULT 0,
            wins_a INTEGER NOT NULL DEFAULT 0,
            wins_b INTEGER NOT NULL DEFAULT 0,
            last_played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (auth_a, auth_b)
        );
    `);
    // Room-wide "best ever" records (requested 2026-08-17) — one row per
    // tracked category (currently just 'winStreak'), overwritten wholesale
    // whenever a new value beats it. Deliberately generic (category as a
    // free-text key) rather than one dedicated column per record, so a
    // future record category doesn't need its own migration.
    const roomRecordsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS room_records (
            category TEXT PRIMARY KEY,
            value INTEGER NOT NULL,
            holder_auth TEXT NOT NULL,
            holder_name TEXT NOT NULL,
            achieved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
    // !rating (main room only — see core/stats/analytics/) — one row per
    // player per match, the full 28-metric PlayerMatchReport stored as a
    // JSON payload (same shape as the never-used game_reports table's own
    // report_id/payload precedent) rather than one column per metric: the
    // report is naturally a single structured object, and this keeps adding
    // a metric #29 later a code-only change, no migration. auth/player_name
    // stay real columns since those are what's actually queried on.
    const matchAnalyticsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS match_analytics_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            auth TEXT NOT NULL,
            player_name TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
    // Not database.prepare()'d up here like the CREATE TABLE statements
    // above — unlike a bare CREATE TABLE, CREATE INDEX references an
    // existing table by name, and prepare() validates that against the
    // CURRENT schema immediately, before init() has actually run
    // ratingHistoryStatement to create the table it indexes. exec()'d
    // directly inside init() instead, right after that .run() call.

    // SQLite has no "ADD COLUMN IF NOT EXISTS" — a DB created before a given
    // feature already has the table without that column, and CREATE TABLE IF
    // NOT EXISTS above is a no-op against an existing table. Catching the
    // "duplicate column" error is the standard way to make this idempotent
    // across both fresh and pre-existing databases.
    function addColumnIfMissing(table, columnDefinition) {
        try {
            database.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
        } catch (err) {
            if (!/duplicate column/i.test(err.message)) throw err;
        }
    }

    function init() {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        initStatement.run();
        reportStatement.run();
        mastersStatement.run();
        adminsStatement.run();
        vipsStatement.run();
        addColumnIfMissing('vips', 'expires_at TEXT');
        discordLinksStatement.run();
        telegramLinksStatement.run();
        telegramLinkCodesStatement.run();
        authBansStatement.run();
        addColumnIfMissing('auth_bans', 'expires_at TEXT');
        commandRestrictionsStatement.run();
        settingsStatement.run();
        seasonTrophiesStatement.run();
        playerItemsStatement.run();
        addColumnIfMissing('player_stats', 'balance INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing('player_stats', 'equipped_form TEXT');
        addColumnIfMissing('player_stats', 'equipped_goal_animation TEXT');
        addColumnIfMissing('player_stats', 'equipped_avatar TEXT');
        addColumnIfMissing('player_stats', 'equipped_size TEXT');
        addColumnIfMissing('player_stats', 'equipped_trophy TEXT');
        addColumnIfMissing('player_stats', 'hide_custom_colors INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing('player_stats', 'vip_color INTEGER');
        addColumnIfMissing('player_stats', 'daily_streak INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing('player_stats', 'last_daily_at TEXT');
        addColumnIfMissing('player_items', 'level INTEGER NOT NULL DEFAULT 1');
        // openskill/BFF rating (see core/bff/rating.js) — only meaningfully
        // populated in a BFF-room DB file; the main room's player_stats
        // simply never touches these columns. NULL (not a default 25/8.333
        // row) means "never played a ranked BFF match yet" — the caller
        // falls back to rating.js's defaultRating() rather than the DB
        // layer inventing openskill-specific defaults itself.
        addColumnIfMissing('player_stats', 'rating_mu REAL');
        addColumnIfMissing('player_stats', 'rating_sigma REAL');
        clubsStatement.run();
        clubMembersStatement.run();
        clubInvitesStatement.run();
        ratingHistoryStatement.run();
        database.exec('CREATE INDEX IF NOT EXISTS idx_rating_history_auth ON rating_history (auth, id DESC)');
        silencedPairsStatement.run();
        headToHeadStatement.run();
        roomRecordsStatement.run();
        matchAnalyticsStatement.run();
        database.exec('CREATE INDEX IF NOT EXISTS idx_match_analytics_auth ON match_analytics_reports (auth, id DESC)');
        // !viphide (both rooms — see commands/player.js / bff/commands.js),
        // same shape/reasoning as hide_custom_colors above (requested
        // 2026-08-16: survive a restart, keyed by auth rather than the old
        // player.id — which also happened to be silently broken across a
        // mere reconnect, not just a restart, since player.id never
        // survives that either).
        addColumnIfMissing('player_stats', 'hide_vip_prefix INTEGER NOT NULL DEFAULT 0');
        // Classic ELO (main room only — see core/stats/elo.js) — a plain
        // always-present metric alongside games/wins/goals/etc, NOT the
        // nullable BFF-style rating_mu/rating_sigma above: every player has
        // an ELO from the moment their row exists, same as `games`.
        addColumnIfMissing('player_stats', 'elo_rating INTEGER NOT NULL DEFAULT 1000');
        addColumnIfMissing('clubs', 'emoji TEXT');
        addColumnIfMissing('clubs', 'assistant_auth TEXT');
        addColumnIfMissing('clubs', 'color_unlocked INTEGER NOT NULL DEFAULT 0');
        // !tops clubs (see addClubStats/getTopClubs below) — goals/assists/
        // clean_sheets credited to a club whenever a CURRENT member earns
        // them (see roomStats.js's updatePlayerStats), weighted equally
        // (each worth 1 toward the combined ranking score).
        addColumnIfMissing('clubs', 'goals INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing('clubs', 'assists INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing('clubs', 'clean_sheets INTEGER NOT NULL DEFAULT 0');
        return true;
    }

    function getSetting(key) {
        const row = database.prepare('SELECT value FROM bot_settings WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    function setSetting(key, value) {
        database
            .prepare(
                `INSERT INTO bot_settings (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
            )
            .run(key, value);
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
            elo: row.elo_rating,
        };
    }

    const PLAYER_STATS_COLUMNS = 'player_name, games, wins, goals, assists, own_goals, clean_sheets, playtime, elo_rating';

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
                    (auth, player_name, games, wins, goals, assists, own_goals, clean_sheets, playtime, elo_rating, updated_at)
                 VALUES
                    (@auth, @playerName, @games, @wins, @goals, @assists, @ownGoals, @CS, @playtime, @elo, CURRENT_TIMESTAMP)
                 ON CONFLICT(auth) DO UPDATE SET
                    player_name = excluded.player_name,
                    games = excluded.games,
                    wins = excluded.wins,
                    goals = excluded.goals,
                    assists = excluded.assists,
                    own_goals = excluded.own_goals,
                    clean_sheets = excluded.clean_sheets,
                    playtime = excluded.playtime,
                    elo_rating = excluded.elo_rating,
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
                elo: stats.elo ?? 1000,
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
        elo: 'elo_rating',
    };

    // One-off backfill support (scripts/backfill-elo.js) — bulk read for
    // every player with enough games for a trustworthy per-game rate,
    // and a narrow single-column setter so the backfill never risks
    // zeroing out unrelated columns the way a partial savePlayerStats call
    // would.
    function getPlayerStatsForSeed(minGames) {
        return database
            .prepare(
                `SELECT auth, player_name AS playerName, games, wins, goals, assists, clean_sheets AS CS
                 FROM player_stats WHERE games >= ?`
            )
            .all(minGames);
    }

    function setEloRating(auth, elo) {
        database.prepare('UPDATE player_stats SET elo_rating = ? WHERE auth = ?').run(elo, auth);
    }

    // `auth` is included alongside the display fields specifically so a
    // caller can check "is THIS auth in the top N" reliably (see
    // voteBan.js's protected-top-10 check) — matching by player_name alone
    // would be fragile (not unique, changes via !rename).
    function getLeaderboard(statKey, limit) {
        const column = LEADERBOARD_COLUMNS[statKey];
        if (!column) throw new Error(`getLeaderboard: unknown statKey "${statKey}"`);

        const rows = database
            .prepare(`SELECT auth, player_name AS playerName, ${column} AS value FROM player_stats ORDER BY ${column} DESC LIMIT ?`)
            .all(limit);

        return rows.map((row) => ({ auth: row.auth, playerName: row.playerName, value: row.value }));
    }

    // Rank of a given stat value among all players (1-indexed, ties share the
    // same rank via COUNT(*)+1 rather than a window function — node:sqlite's
    // bundled SQLite may not have RANK() available). `total` is the player
    // count the rank is out of, for a "n/m" display.
    function getStatRank(statKey, value) {
        const column = LEADERBOARD_COLUMNS[statKey];
        if (!column) throw new Error(`getStatRank: unknown statKey "${statKey}"`);

        const rank = database
            .prepare(`SELECT COUNT(*) + 1 AS rank FROM player_stats WHERE ${column} > ?`)
            .get(value).rank;
        const total = database.prepare('SELECT COUNT(*) AS total FROM player_stats').get().total;

        return { rank, total };
    }

    // Returns null if `auth` has never played a ranked BFF match — the
    // caller (core/bff/rating.js consumers) is the one that knows to fall
    // back to defaultRating() in that case, not this layer.
    function getRating(auth) {
        const row = database.prepare('SELECT rating_mu AS mu, rating_sigma AS sigma FROM player_stats WHERE auth = ?').get(auth);
        if (!row || row.mu == null || row.sigma == null) return null;
        return { mu: row.mu, sigma: row.sigma };
    }

    // Upserts like addCoins — a player's first-ever ranked BFF match may
    // not have a player_stats row at all yet.
    function saveRating(auth, playerName, mu, sigma) {
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, rating_mu, rating_sigma)
                 VALUES (@auth, @playerName, @mu, @sigma)
                 ON CONFLICT(auth) DO UPDATE SET rating_mu = @mu, rating_sigma = @sigma`
            )
            .run({ auth, playerName: playerName ?? '', mu, sigma });
    }

    // Appends one row per ranked match (see matchFlow.js's handlePlayersStop)
    // — `delta` already in display-rescaled points, see rating_history's own
    // table comment above.
    function saveRatingHistory(auth, delta) {
        database.prepare('INSERT INTO rating_history (auth, delta) VALUES (?, ?)').run(auth, delta);
    }

    // Sum of the last `limit` deltas for `auth`, most recent first — null
    // (not 0) when there's no history at all yet, so a caller can tell
    // "never played a ranked match" apart from "played some and it netted
    // to exactly zero." limit is applied inside the subquery, not the outer
    // SUM, specifically so it only ever sums the LAST N rows, not all of
    // them. Ordered by `id DESC`, NOT `created_at DESC`: CURRENT_TIMESTAMP
    // is only second-granularity, and a full match's worth of rating writes
    // (up to 8 players) routinely lands within the same second, which made
    // "most recent" ties resolve arbitrarily — confirmed live by a direct
    // sanity check while building this (a 4th/5th/6th insert in the same
    // second summed as if it were the 1st/2nd/3rd). `id` is AUTOINCREMENT,
    // genuinely monotonic with insertion order regardless of timestamp
    // resolution.
    function getRecentRatingDelta(auth, limit) {
        const row = database
            .prepare(
                `SELECT COUNT(*) AS cnt, COALESCE(SUM(delta), 0) AS total FROM (
                    SELECT delta FROM rating_history WHERE auth = ? ORDER BY id DESC LIMIT ?
                 )`
            )
            .get(auth, limit);
        return row.cnt === 0 ? null : row.total;
    }

    // ordinal = mu - 3*sigma, openskill's own default ordinal() formula
    // (Z=3, ALPHA=1, TARGET=0 — see node_modules/openskill/dist/rating.js)
    // computed directly in SQL so this can ORDER BY/LIMIT without pulling
    // every rated player into JS first. Must stay in sync with that
    // default if core/bff/rating.js's computeOrdinal() options ever change.
    // Unrated players (NULL mu/sigma) are excluded, same as getTopPlayers'
    // "hasn't played yet" rows never showing up on a leaderboard.
    function getRatingLeaderboard(limit) {
        return database
            .prepare(
                `SELECT auth, player_name AS playerName, rating_mu AS mu, rating_sigma AS sigma,
                    (rating_mu - 3 * rating_sigma) AS ordinal
                 FROM player_stats
                 WHERE rating_mu IS NOT NULL AND rating_sigma IS NOT NULL
                 ORDER BY ordinal DESC
                 LIMIT ?`
            )
            .all(limit);
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

    // Sweeps expired grants (like getAuthBans does for bans) before
    // reading, so an expired VIP never needs a separate cleanup job — the
    // list this returns is always the currently-active set.
    function getVips() {
        database.prepare('DELETE FROM vips WHERE expires_at IS NOT NULL AND expires_at <= ?').run(new Date().toISOString());
        return database
            .prepare('SELECT auth, player_name AS playerName, expires_at AS expiresAt FROM vips')
            .all();
    }

    // expiresAt is an already-computed ISO string (or null for a permanent
    // grant) rather than a raw duration — unlike banAuth's durationMinutes,
    // the caller (commands/master.js) also needs this exact value to keep
    // state.vipList's cached copy in sync, so it computes it once itself
    // rather than have two places derive it and risk drifting apart.
    function addVip(auth, playerName, expiresAt) {
        database
            .prepare(
                `INSERT INTO vips (auth, player_name, expires_at) VALUES (?, ?, ?)
                 ON CONFLICT(auth) DO UPDATE SET player_name = excluded.player_name, expires_at = excluded.expires_at`
            )
            .run(auth, playerName, expiresAt ?? null);
    }

    function removeVip(auth) {
        database.prepare('DELETE FROM vips WHERE auth = ?').run(auth);
    }

    // A player may relink to a different Discord account (e.g. a typo the
    // first time), so this upserts rather than rejecting an existing link.
    // Returns whether `auth` had no prior link at all, so callers (the
    // one-time link bonus in commands/player.js) can tell a genuine first
    // link apart from a relink.
    function linkDiscordId(auth, discordId) {
        const isNewLink = !database.prepare('SELECT 1 FROM discord_links WHERE auth = ?').get(auth);
        database
            .prepare(
                `INSERT INTO discord_links (auth, discord_id, linked_at) VALUES (@auth, @discordId, CURRENT_TIMESTAMP)
                 ON CONFLICT(auth) DO UPDATE SET discord_id = excluded.discord_id, linked_at = CURRENT_TIMESTAMP`
            )
            .run({ auth, discordId });
        return isNewLink;
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

    // `target` is `{ auth }` (issued from the room via !telegram) or
    // `{ telegramChatId }` (issued from Telegram via /start) — exactly one,
    // the other stays NULL until redemption fills it in.
    function createTelegramLinkCode(code, target, expiresAt) {
        database
            .prepare(
                `INSERT INTO telegram_link_codes (code, auth, telegram_chat_id, expires_at)
                 VALUES (@code, @auth, @telegramChatId, @expiresAt)`
            )
            .run({
                code,
                auth: target.auth ?? null,
                telegramChatId: target.telegramChatId ?? null,
                expiresAt,
            });
    }

    // Looks up and deletes in one call — a code is single-use either way
    // (redeemed or expired). Expired codes are swept lazily here first, same
    // style as getClubInvites' own sweep, rather than a separate cron.
    // Returns the pending row (or null if the code doesn't exist/expired),
    // leaving it to the caller to decide which half was already set.
    function redeemTelegramLinkCode(code) {
        const nowIso = new Date().toISOString();
        database.prepare('DELETE FROM telegram_link_codes WHERE expires_at <= ?').run(nowIso);
        const row = database.prepare('SELECT auth, telegram_chat_id AS telegramChatId FROM telegram_link_codes WHERE code = ?').get(code);
        if (!row) return null;
        database.prepare('DELETE FROM telegram_link_codes WHERE code = ?').run(code);
        return row;
    }

    // Upsert, same shape as linkDiscordId — a player may relink to a
    // different Telegram account (e.g. switched phones) rather than being
    // stuck with the first one forever.
    function linkTelegramId(auth, telegramChatId) {
        database
            .prepare(
                `INSERT INTO telegram_links (auth, telegram_chat_id, linked_at) VALUES (@auth, @telegramChatId, CURRENT_TIMESTAMP)
                 ON CONFLICT(auth) DO UPDATE SET telegram_chat_id = excluded.telegram_chat_id, linked_at = CURRENT_TIMESTAMP`
            )
            .run({ auth, telegramChatId });
    }

    function getAuthByTelegramId(telegramChatId) {
        const row = database.prepare('SELECT auth FROM telegram_links WHERE telegram_chat_id = ?').get(telegramChatId);
        return row ? row.auth : null;
    }

    // durationMinutes is required by every current caller (!ban/!banauth/
    // `/banauth` all validate this themselves before calling in) — a null/0
    // here only ever happens for data written before the mandatory-duration
    // change, never as a deliberate "permanent ban" request anymore.
    function banAuth(auth, playerName, reason, durationMinutes) {
        const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60000).toISOString() : null;
        database
            .prepare(
                `INSERT INTO auth_bans (auth, player_name, reason, banned_at, expires_at)
                 VALUES (@auth, @playerName, @reason, CURRENT_TIMESTAMP, @expiresAt)
                 ON CONFLICT(auth) DO UPDATE SET
                    player_name = excluded.player_name,
                    reason = excluded.reason,
                    banned_at = CURRENT_TIMESTAMP,
                    expires_at = excluded.expires_at`
            )
            .run({ auth, playerName: playerName ?? '', reason: reason ?? '', expiresAt });
    }

    function unbanAuth(auth) {
        database.prepare('DELETE FROM auth_bans WHERE auth = ?').run(auth);
    }

    function isBanExpired(expiresAt) {
        return expiresAt != null && new Date(expiresAt).getTime() <= Date.now();
    }

    // A ban past its expiry is functionally identical to no ban at all —
    // deleting it here (rather than just filtering it out) means it never
    // needs a separate cleanup job, and getAuthBans()/room.onPlayerJoin both
    // see the same up-to-date picture without duplicating the expiry check.
    function getAuthBan(auth) {
        const row = database
            .prepare('SELECT auth, player_name AS playerName, reason, expires_at AS expiresAt FROM auth_bans WHERE auth = ?')
            .get(auth);
        if (!row) return null;
        if (isBanExpired(row.expiresAt)) {
            database.prepare('DELETE FROM auth_bans WHERE auth = ?').run(auth);
            return null;
        }
        return row;
    }

    function getAuthBans() {
        database.prepare('DELETE FROM auth_bans WHERE expires_at IS NOT NULL AND expires_at <= ?').run(new Date().toISOString());
        return database
            .prepare('SELECT auth, player_name AS playerName, reason, expires_at AS expiresAt FROM auth_bans ORDER BY banned_at DESC')
            .all();
    }

    // durationMinutes falsy (0/null/undefined) means permanent — same
    // convention banAuth's own expiresAt ternary uses, just not gated behind
    // a "always mandatory" command-layer rule like banAuth's is: !restrictcmd
    // deliberately supports both temporary and permanent restrictions.
    function restrictCommand(auth, command, playerName, reason, durationMinutes) {
        const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60000).toISOString() : null;
        database
            .prepare(
                `INSERT INTO command_restrictions (auth, command, player_name, reason, restricted_at, expires_at)
                 VALUES (@auth, @command, @playerName, @reason, CURRENT_TIMESTAMP, @expiresAt)
                 ON CONFLICT(auth, command) DO UPDATE SET
                    player_name = excluded.player_name,
                    reason = excluded.reason,
                    restricted_at = CURRENT_TIMESTAMP,
                    expires_at = excluded.expires_at`
            )
            .run({ auth, command, playerName: playerName ?? '', reason: reason ?? '', expiresAt });
    }

    function unrestrictCommand(auth, command) {
        database.prepare('DELETE FROM command_restrictions WHERE auth = ? AND command = ?').run(auth, command);
    }

    // A restriction past its expiry is functionally identical to no
    // restriction at all — deleted here (not just filtered out) for the same
    // reason getAuthBan does it: no separate cleanup job needed, and every
    // caller sees the same up-to-date picture.
    function getCommandRestriction(auth, command) {
        const row = database
            .prepare('SELECT auth, command, player_name AS playerName, reason, expires_at AS expiresAt FROM command_restrictions WHERE auth = ? AND command = ?')
            .get(auth, command);
        if (!row) return null;
        if (isBanExpired(row.expiresAt)) {
            database.prepare('DELETE FROM command_restrictions WHERE auth = ? AND command = ?').run(auth, command);
            return null;
        }
        return row;
    }

    function getCommandRestrictions() {
        database.prepare('DELETE FROM command_restrictions WHERE expires_at IS NOT NULL AND expires_at <= ?').run(new Date().toISOString());
        return database
            .prepare('SELECT auth, command, player_name AS playerName, reason, expires_at AS expiresAt FROM command_restrictions ORDER BY restricted_at DESC')
            .all();
    }

    // Upserts so a player who has never finished a quals game (and so has no
    // player_stats row yet — see roomStats.js's full-house gate) still gets
    // a row the first time they ever earn coins, instead of needing one to
    // already exist. Only touches auth/player_name/balance — untouched by
    // savePlayerStats's own upsert (and vice versa), so the two can never
    // clobber each other.
    function addCoins(auth, playerName, amount) {
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, balance)
                 VALUES (@auth, @playerName, @amount)
                 ON CONFLICT(auth) DO UPDATE SET balance = balance + @amount`
            )
            .run({ auth, playerName: playerName ?? '', amount });
    }

    function getBalance(auth) {
        const row = database.prepare('SELECT balance FROM player_stats WHERE auth = ?').get(auth);
        return row ? row.balance : 0;
    }

    // Atomic like buyItem/upgradeItem below: checks and deducts within this
    // same synchronous call, so a caller (see core/commands/minigames.js's
    // wager resolution) can't be double-charged or race a balance check
    // against a concurrent spend. Returns false (no charge) on insufficient
    // funds.
    function spendCoins(auth, playerName, amount) {
        if (getBalance(auth) < amount) return false;
        addCoins(auth, playerName, -amount);
        return true;
    }

    // !daily-style login bonus (see economy.js's onPlayerJoin hook) — day N
    // of the streak pays coinsPerStreak*N, capped at maxStreak (day
    // maxStreak+1 wraps back around to day 1 rather than growing forever).
    // Whole read-decide-write sequence happens inside this one synchronous
    // call (same reasoning as buyItem/upgradeItem) so two joins landing close
    // together — e.g. a reconnect — can't race their way into a double
    // payout for the same day. Returns null (no charge) if `auth` already
    // claimed today; otherwise { amount, streak, newBalance }.
    function claimDailyBonus(auth, playerName, coinsPerStreak, maxStreak) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const row = database.prepare('SELECT balance, daily_streak, last_daily_at FROM player_stats WHERE auth = ?').get(auth);
        if (row && row.last_daily_at === todayStr) return null;

        const yesterday = new Date();
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);

        const wasConsecutive = row && row.last_daily_at === yesterdayStr;
        let streak = wasConsecutive ? row.daily_streak + 1 : 1;
        if (streak > maxStreak) streak = 1;

        const amount = streak * coinsPerStreak;
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, balance, daily_streak, last_daily_at)
                 VALUES (@auth, @playerName, @amount, @streak, @todayStr)
                 ON CONFLICT(auth) DO UPDATE SET
                    balance = balance + @amount,
                    daily_streak = @streak,
                    last_daily_at = @todayStr`
            )
            .run({ auth, playerName: playerName ?? '', amount, streak, todayStr });

        const newBalance = (row ? row.balance : 0) + amount;
        return { amount, streak, newBalance };
    }

    function getOwnedItemIds(auth) {
        return database
            .prepare('SELECT item_id FROM player_items WHERE auth = ?')
            .all(auth)
            .map((row) => row.item_id);
    }

    function ownsItem(auth, itemId) {
        return database.prepare('SELECT 1 FROM player_items WHERE auth = ? AND item_id = ?').get(auth, itemId) != null;
    }

    // Atomic in practice: node:sqlite's DatabaseSync executes every call
    // synchronously, so nothing else in this process can interleave between
    // the balance check and the deduction — no explicit transaction needed.
    // Returns false (no charge, no purchase) on insufficient funds or an
    // already-owned item, so the caller can't double-charge by retrying.
    function buyItem(auth, playerName, itemId, price) {
        if (ownsItem(auth, itemId)) return false;
        if (getBalance(auth) < price) return false;
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, balance)
                 VALUES (@auth, @playerName, -@price)
                 ON CONFLICT(auth) DO UPDATE SET balance = balance - @price`
            )
            .run({ auth, playerName: playerName ?? '', price });
        database.prepare('INSERT INTO player_items (auth, item_id) VALUES (?, ?)').run(auth, itemId);
        return true;
    }

    // 0 if never bought at all (not just level 1) — lets the caller (see
    // economy.js's shopCommand) treat "never owned" and "owned at level N"
    // uniformly as just "current level, buy the next one".
    function getItemLevel(auth, itemId) {
        const row = database.prepare('SELECT level FROM player_items WHERE auth = ? AND item_id = ?').get(auth, itemId);
        return row ? row.level : 0;
    }

    // Migration-only (see scripts/migrate-size-levels.js) — every owner of a
    // given upgradeable item, with their raw current level. No in-game
    // command reads this; it exists purely to let a script re-derive every
    // affected auth when an item's level scale itself changes.
    function getItemOwners(itemId) {
        return database.prepare('SELECT auth, level FROM player_items WHERE item_id = ?').all(itemId);
    }

    // Migration-only, same reasoning as getItemOwners — a raw level write
    // with no cost/balance logic at all, unlike upgradeItem. Never called
    // from an in-game command.
    function setItemLevel(auth, itemId, level) {
        database.prepare('UPDATE player_items SET level = ? WHERE auth = ? AND item_id = ?').run(level, auth, itemId);
    }

    // Atomic like buyItem: re-reads the current level and re-checks the
    // balance inside this same synchronous call. expectedCurrentLevel guards
    // against a stale read winning a race (e.g. two rapid !shop calls) —
    // if the level has already moved on, this fails rather than skipping or
    // double-charging a tier. First purchase is level 0 -> 1, same call.
    function upgradeItem(auth, playerName, itemId, cost, expectedCurrentLevel) {
        if (getItemLevel(auth, itemId) !== expectedCurrentLevel) return false;
        if (getBalance(auth) < cost) return false;
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, balance)
                 VALUES (@auth, @playerName, -@cost)
                 ON CONFLICT(auth) DO UPDATE SET balance = balance - @cost`
            )
            .run({ auth, playerName: playerName ?? '', cost });
        database
            .prepare(
                `INSERT INTO player_items (auth, item_id, level) VALUES (@auth, @itemId, @level)
                 ON CONFLICT(auth, item_id) DO UPDATE SET level = excluded.level`
            )
            .run({ auth, itemId, level: expectedCurrentLevel + 1 });
        return true;
    }

    // slot is 'form', 'goalAnimation', 'avatar' or 'size' (validated by the
    // caller, core/economy.js, which is also the only place that knows the
    // shop catalog and can check ownership before calling this) or 'trophy'
    // (validated by core/commands/trophies.js the same way). 'avatar' (the
    // fire/star/skull/crown flashes) and 'goalAnimation' (smoke/fireworks)
    // used to share one slot/type — split into their own columns so both can
    // be equipped and fire at once, since they're not actually the same kind
    // of thing (see shopItems.js).
    const EQUIPPED_SLOT_COLUMNS = {
        form: 'equipped_form',
        goalAnimation: 'equipped_goal_animation',
        avatar: 'equipped_avatar',
        size: 'equipped_size',
        trophy: 'equipped_trophy',
    };

    function setEquipped(auth, slot, itemId) {
        const column = EQUIPPED_SLOT_COLUMNS[slot];
        database.prepare(`UPDATE player_stats SET ${column} = ? WHERE auth = ?`).run(itemId, auth);
    }

    function getEquipped(auth) {
        const row = database
            .prepare('SELECT equipped_form AS form, equipped_goal_animation AS goalAnimation, equipped_avatar AS avatar, equipped_size AS size, equipped_trophy AS trophy FROM player_stats WHERE auth = ?')
            .get(auth);
        return row ? row : { form: null, goalAnimation: null, avatar: null, size: null, trophy: null };
    }

    // Every auth with a trophy currently equipped — loaded once at startup
    // into state.equippedTrophies (see entry.js), same in-memory-cache
    // reasoning as adminList/vipList/clubs: the per-message chat prefix
    // (events/activity.js) can't afford a DB round trip on every message.
    function getAllEquippedTrophies() {
        return database
            .prepare('SELECT auth, equipped_trophy AS trophy FROM player_stats WHERE equipped_trophy IS NOT NULL')
            .all();
    }

    // !customcolors (see commands/player.js) — a player's own opt-out from
    // seeing OTHER players' club custom colors in chat (the club prefix
    // TEXT still shows either way, only the color falls back to default).
    // Upserts rather than a plain UPDATE (unlike setEquipped) since a player
    // toggling this may not have a player_stats row yet at all — nothing
    // else about them needs to exist first.
    function setHideCustomColors(auth, hidden) {
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, hide_custom_colors)
                 VALUES (@auth, '', @hidden)
                 ON CONFLICT(auth) DO UPDATE SET hide_custom_colors = @hidden`
            )
            .run({ auth, hidden: hidden ? 1 : 0 });
    }

    // Every auth that has opted out — loaded once at startup into
    // state.hiddenCustomColorsSet (see entry.js), same in-memory-cache
    // reasoning as equippedTrophies/clubs/adminList/vipList above.
    function getAllHiddenCustomColors() {
        return database
            .prepare('SELECT auth FROM player_stats WHERE hide_custom_colors = 1')
            .all()
            .map((row) => row.auth);
    }

    // !viphide (see commands/player.js / bff/commands.js) — same upsert
    // shape as setHideCustomColors above, for the same reason (a VIP may
    // not have a player_stats row yet the first time they toggle this).
    function setHiddenVip(auth, hidden) {
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, hide_vip_prefix)
                 VALUES (@auth, '', @hidden)
                 ON CONFLICT(auth) DO UPDATE SET hide_vip_prefix = @hidden`
            )
            .run({ auth, hidden: hidden ? 1 : 0 });
    }

    // Every auth that has hidden their VIP prefix — loaded once at startup
    // into hiddenVipSet (see entry.js/bffEntry.js), same in-memory-cache
    // reasoning as getAllHiddenCustomColors above.
    function getAllHiddenVipAuths() {
        return database
            .prepare('SELECT auth FROM player_stats WHERE hide_vip_prefix = 1')
            .all()
            .map((row) => row.auth);
    }

    // !silence (see commands/player.js) — per-VIEWER chat filter, viewer ->
    // target. INSERT OR IGNORE rather than an upsert: the pair itself IS
    // the full row, so a duplicate insert (shouldn't happen — the caller
    // already checks membership before calling) is simply a no-op, not a
    // meaningful update.
    function addSilence(viewerAuth, targetAuth) {
        database
            .prepare('INSERT OR IGNORE INTO silenced_pairs (viewer_auth, target_auth) VALUES (?, ?)')
            .run(viewerAuth, targetAuth);
    }

    function removeSilence(viewerAuth, targetAuth) {
        database
            .prepare('DELETE FROM silenced_pairs WHERE viewer_auth = ? AND target_auth = ?')
            .run(viewerAuth, targetAuth);
    }

    // Every persisted (viewer, target) pair — loaded once at startup into
    // silencedAuths (see entry.js), same in-memory-cache reasoning as
    // getAllHiddenVipAuths above.
    function getAllSilencedPairs() {
        return database
            .prepare('SELECT viewer_auth AS viewerAuth, target_auth AS targetAuth FROM silenced_pairs')
            .all();
    }

    // Records one match's OUTCOME between two auths who were on OPPOSING
    // teams (see head_to_head's own doc comment — teammates never call
    // this). `winnerAuth` is one of authA/authB, or null for a draw (a draw
    // still touches last_played_at/creates the row, just doesn't move
    // either win count — see #13's same-day-rematch check, which only
    // needs last_played_at, not a winner). Normalizes the pair to
    // auth_a < auth_b internally so the caller never has to know or care
    // which order they passed them in.
    function recordHeadToHead(authA, authB, winnerAuth) {
        const [a, b] = authA < authB ? [authA, authB] : [authB, authA];
        const winsAIncrement = winnerAuth === a ? 1 : 0;
        const winsBIncrement = winnerAuth === b ? 1 : 0;
        database
            .prepare(
                `INSERT INTO head_to_head (auth_a, auth_b, games, wins_a, wins_b, last_played_at)
                 VALUES (@a, @b, 1, @winsAIncrement, @winsBIncrement, CURRENT_TIMESTAMP)
                 ON CONFLICT(auth_a, auth_b) DO UPDATE SET
                    games = games + 1,
                    wins_a = wins_a + @winsAIncrement,
                    wins_b = wins_b + @winsBIncrement,
                    last_played_at = CURRENT_TIMESTAMP`
            )
            .run({ a, b, winsAIncrement, winsBIncrement });
    }

    // Returns null if this pair has never faced each other as opponents.
    // winsFor/winsAgainst are already reoriented to the CALLER's own
    // authA/authB argument order — the caller never needs to know about
    // the internal auth_a < auth_b storage normalization. `games` is its
    // own counter (not winsA+winsB — a draw touches games but moves
    // neither win count, so summing wins alone would silently undercount
    // every draw this pair has ever played).
    function getHeadToHead(authA, authB) {
        const [a, b] = authA < authB ? [authA, authB] : [authB, authA];
        const row = database
            .prepare('SELECT games, wins_a AS winsA, wins_b AS winsB, last_played_at AS lastPlayedAt FROM head_to_head WHERE auth_a = ? AND auth_b = ?')
            .get(a, b);
        if (!row) return null;
        const flipped = a !== authA;
        return {
            winsFor: flipped ? row.winsB : row.winsA,
            winsAgainst: flipped ? row.winsA : row.winsB,
            games: row.games,
            lastPlayedAt: row.lastPlayedAt,
        };
    }

    // Room-wide "best ever" record for one category — see room_records'
    // own doc comment. null if the category has never been set at all.
    function getRecord(category) {
        return database
            .prepare('SELECT value, holder_auth AS holderAuth, holder_name AS holderName, achieved_at AS achievedAt FROM room_records WHERE category = ?')
            .get(category) ?? null;
    }

    // Unconditional overwrite — the caller (whoever tracks the live value,
    // e.g. state.streak) is the one that already checked this beats the
    // current record before calling, same "caller decides, this just
    // writes" division of responsibility as setClubColor.
    function setRecord(category, value, holderAuth, holderName) {
        database
            .prepare(
                `INSERT INTO room_records (category, value, holder_auth, holder_name)
                 VALUES (@category, @value, @holderAuth, @holderName)
                 ON CONFLICT(category) DO UPDATE SET
                    value = @value, holder_auth = @holderAuth, holder_name = @holderName, achieved_at = CURRENT_TIMESTAMP`
            )
            .run({ category, value, holderAuth, holderName });
    }

    // !vipcolor (see commands/player.js) — a VIP's own override for their
    // role's chat color (vipChatColor, see constants.js), which everyone
    // sees the same way (unlike !customcolors' per-viewer club-color
    // opt-out — this isn't personalizable per-viewer, just per-VIP-sender).
    // color may be null to clear back to the shared default. Upserts for
    // the same reason setHideCustomColors does: a VIP may not have a
    // player_stats row yet.
    function setVipColor(auth, color) {
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, vip_color)
                 VALUES (@auth, '', @color)
                 ON CONFLICT(auth) DO UPDATE SET vip_color = @color`
            )
            .run({ auth, color });
    }

    // Every auth with a custom VIP color set — loaded once at startup into
    // state.vipColors (see entry.js), same in-memory-cache reasoning as
    // hiddenCustomColorsSet/equippedTrophies/clubs above.
    function getAllVipColors() {
        return database
            .prepare('SELECT auth, vip_color AS color FROM player_stats WHERE vip_color IS NOT NULL')
            .all();
    }

    // Same >=5-player quorum as printRankings' leaderboards (see
    // roomStats.js) before anyone is "Top-3" at all — otherwise the first
    // few players in a fresh room would all hand themselves trophies off a
    // near-empty table. Refreshed once per completed match (roomStats.js's
    // updateStats()), not per chat message — see state.topPlayers. Each
    // category holds up to 3 entries, ordered rank 1st/2nd/3rd — a player's
    // actual rank (and so which medal they get, see utils.js's
    // formatTrophyLabel) is just their index in that array.
    const TROPHY_QUORUM = 5;
    const TROPHY_RANKS = 3;
    function getTopPlayers() {
        const total = database.prepare('SELECT COUNT(*) AS n FROM player_stats').get().n;
        if (total < TROPHY_QUORUM) {
            return { goals: [], assists: [], cs: [], wr: [], pt: [] };
        }
        function topByColumn(column) {
            return database
                .prepare(`SELECT auth, player_name AS playerName, ${column} AS value FROM player_stats ORDER BY ${column} DESC LIMIT ?`)
                .all(TROPHY_RANKS);
        }
        const topWinrate = database
            .prepare(
                `SELECT auth, player_name AS playerName, (CAST(wins AS REAL) / games) AS value
                 FROM player_stats WHERE games > 0 ORDER BY value DESC, games DESC LIMIT ?`
            )
            .all(TROPHY_RANKS);
        return {
            goals: topByColumn('goals'),
            assists: topByColumn('assists'),
            cs: topByColumn('clean_sheets'),
            wr: topWinrate,
            pt: topByColumn('playtime'),
        };
    }

    /* SEASONS */

    // 0 until the very first closeSeason() ever runs (no 'currentSeason' key
    // yet) — the season currently being played is "season 0" by convention,
    // matching how getTopPlayers()/state.topPlayers already behaves with no
    // season concept at all today.
    function getCurrentSeason() {
        return parseInt(getSetting('currentSeason') ?? '0', 10);
    }

    // Every already-closed season's frozen top-3, across every category —
    // loaded once into state.seasonTrophies at startup (see entry.js), same
    // in-memory-cache reasoning as getAllEquippedTrophies/getAllClubs/etc,
    // since these rows never change again once closeSeason() writes them.
    function getSeasonTrophies() {
        return database
            .prepare('SELECT season, category, rank, auth, player_name AS playerName, value FROM season_trophies ORDER BY season DESC, category, rank')
            .all();
    }

    // Ends the current season: freezes its top-3 (via getTopPlayers(), same
    // quorum/ranking rules as the live !trophy display) into season_trophies
    // forever, resets every player's GAME stats to 0 — but deliberately
    // leaves balance, owned shop items (player_items), equipped cosmetics,
    // daily_streak and every other non-stat column untouched — then advances
    // currentSeason by one. A player who held rank 1-3 keeps showing that
    // exact title afterward simply by re-pointing their !trophy pick at the
    // now-closed season (see commands/trophies.js) — their equipped_trophy
    // column itself needs no migration, it just naturally stops matching the
    // (now all-zero) live standings until they either pick the frozen
    // season's trophy or earn a new one.
    // Guarded by a 'seasonClosed:<N>' bot_settings flag (same idempotency
    // pattern as scripts/migrate-size-levels.js's MIGRATION_FLAG) so running
    // this twice — a restart mid-run, or by mistake — can't double-close a
    // season or wipe stats a second time.
    function closeSeason() {
        const season = getCurrentSeason();
        const closedFlagKey = `seasonClosed:${season}`;
        if (getSetting(closedFlagKey) != null) {
            return { alreadyClosed: true, season };
        }

        const top = getTopPlayers();
        const insertTrophy = database.prepare(
            'INSERT INTO season_trophies (season, category, rank, auth, player_name, value) VALUES (?, ?, ?, ?, ?, ?)'
        );
        let trophiesSaved = 0;
        for (const [category, entries] of Object.entries(top)) {
            entries.forEach((entry, i) => {
                insertTrophy.run(season, category, i + 1, entry.auth, entry.playerName, entry.value);
                trophiesSaved++;
            });
        }

        database.exec(
            `UPDATE player_stats SET
                games = 0, wins = 0, goals = 0, assists = 0, own_goals = 0,
                clean_sheets = 0, playtime = 0, updated_at = CURRENT_TIMESTAMP`
        );

        setSetting(closedFlagKey, new Date().toISOString());
        setSetting('currentSeason', String(season + 1));

        return { alreadyClosed: false, season, nextSeason: season + 1, trophiesSaved };
    }

    /* CLUBS */

    function rowToClub(row) {
        if (!row) return null;
        return {
            id: row.id, name: row.name, prefix: row.prefix, emoji: row.emoji, ownerAuth: row.ownerAuth,
            assistantAuth: row.assistantAuth, color: row.color, colorUnlocked: !!row.colorUnlocked, slots: row.slots,
        };
    }

    const CLUB_COLUMNS = 'id, name, prefix, emoji, owner_auth AS ownerAuth, assistant_auth AS assistantAuth, color, color_unlocked AS colorUnlocked, slots';

    function getClub(clubId) {
        return rowToClub(database.prepare(`SELECT ${CLUB_COLUMNS} FROM clubs WHERE id = ?`).get(clubId));
    }

    function getAllClubs() {
        return database.prepare(`SELECT ${CLUB_COLUMNS} FROM clubs`).all().map(rowToClub);
    }

    function getAllClubMembers() {
        return database
            .prepare('SELECT auth, club_id AS clubId, player_name AS playerName FROM club_members')
            .all();
    }

    // Oldest-first (join order) — used by scripts/cap-club-slots.js to
    // decide who to keep vs. remove when a club's real membership exceeds
    // the new cap: getAllClubMembers() above has no join-order info at all
    // (it exists for the in-memory cache, which never needed it), so this
    // is a separate, single-club query rather than extending that one.
    function getClubMembers(clubId) {
        return database
            .prepare('SELECT auth, player_name AS playerName, joined_at AS joinedAt FROM club_members WHERE club_id = ? ORDER BY joined_at ASC')
            .all(clubId);
    }

    function getClubMembership(auth) {
        const row = database.prepare('SELECT club_id AS clubId FROM club_members WHERE auth = ?').get(auth);
        return row ? row.clubId : null;
    }

    function getClubMemberCount(clubId) {
        return database.prepare('SELECT COUNT(*) AS n FROM club_members WHERE club_id = ?').get(clubId).n;
    }

    // Atomic: re-checks the owner isn't already in a club and has enough
    // coins, then deducts the cost and creates the club + owner membership
    // all inside one synchronous call — same "DatabaseSync runs everything
    // synchronously, nothing else can interleave" reasoning as buyItem.
    // Returns null (no charge, nothing created) rather than throwing, so the
    // caller reports "insufficient funds"/"already in a club" the same way
    // buyItem's `false` return does.
    function createClub(ownerAuth, ownerName, name, prefix, cost) {
        if (getClubMembership(ownerAuth) != null) return null;
        if (getBalance(ownerAuth) < cost) return null;
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, balance)
                 VALUES (@auth, @playerName, -@cost)
                 ON CONFLICT(auth) DO UPDATE SET balance = balance - @cost`
            )
            .run({ auth: ownerAuth, playerName: ownerName ?? '', cost });
        const result = database
            .prepare('INSERT INTO clubs (name, prefix, owner_auth) VALUES (?, ?, ?)')
            .run(name, prefix, ownerAuth);
        const clubId = Number(result.lastInsertRowid);
        database
            .prepare('INSERT INTO club_members (auth, club_id, player_name) VALUES (?, ?, ?)')
            .run(ownerAuth, clubId, ownerName ?? '');
        return getClub(clubId);
    }

    // Re-inviting the same player refreshes their expiry (upsert on
    // (club_id, auth) rather than DO NOTHING) — sending a second invite is a
    // reasonable way to give someone more time, not a no-op.
    function inviteToClub(clubId, auth, durationSeconds) {
        const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
        database
            .prepare(
                `INSERT INTO club_invites (club_id, auth, expires_at) VALUES (?, ?, ?)
                 ON CONFLICT(club_id, auth) DO UPDATE SET invited_at = CURRENT_TIMESTAMP, expires_at = excluded.expires_at`
            )
            .run(clubId, auth, expiresAt);
    }

    // Sweeps every expired invite (not just this auth's) before reading —
    // same "delete past-expiry rows instead of just filtering them out"
    // approach as getAuthBans, so an expired invite never needs a separate
    // cleanup job.
    function getClubInvites(auth) {
        const nowIso = new Date().toISOString();
        database.prepare('DELETE FROM club_invites WHERE expires_at <= ?').run(nowIso);
        return database
            .prepare(
                `SELECT ci.club_id AS clubId, c.name AS clubName, c.prefix AS clubPrefix, c.emoji AS clubEmoji
                 FROM club_invites ci JOIN clubs c ON c.id = ci.club_id
                 WHERE ci.auth = ? ORDER BY ci.invited_at ASC`
            )
            .all(auth);
    }

    // Called once a player accepts ANY invite — every other pending invite
    // for them is now moot (they can only ever be in one club), so all of
    // them are cleared rather than leaving stale rows behind.
    function removeAllClubInvites(auth) {
        database.prepare('DELETE FROM club_invites WHERE auth = ?').run(auth);
    }

    // Atomic: re-checks the invite still exists, the player still isn't in
    // any club, and the club still has a free slot — all inside the same
    // synchronous call, same reasoning as createClub/buyItem. Returns false
    // on any of those failing, so the caller can't double-join by retrying.
    function joinClub(auth, playerName, clubId) {
        const invite = database
            .prepare('SELECT 1 FROM club_invites WHERE club_id = ? AND auth = ? AND expires_at > ?')
            .get(clubId, auth, new Date().toISOString());
        if (!invite) return false;
        if (getClubMembership(auth) != null) return false;
        const club = getClub(clubId);
        if (!club) return false;
        if (getClubMemberCount(clubId) >= club.slots) return false;
        database
            .prepare('INSERT INTO club_members (auth, club_id, player_name) VALUES (?, ?, ?)')
            .run(auth, clubId, playerName ?? '');
        removeAllClubInvites(auth);
        return true;
    }

    function removeClubMember(auth) {
        database.prepare('DELETE FROM club_members WHERE auth = ?').run(auth);
    }

    function disbandClub(clubId) {
        database.prepare('DELETE FROM club_members WHERE club_id = ?').run(clubId);
        database.prepare('DELETE FROM club_invites WHERE club_id = ?').run(clubId);
        database.prepare('DELETE FROM clubs WHERE id = ?').run(clubId);
    }

    // Gated behind !club color buy (see commands/club.js) — setClubColor
    // itself doesn't check colorUnlocked, that's the caller's job, same
    // division of labor as ownership/role checks throughout club.js.
    function setClubColor(clubId, color) {
        database.prepare('UPDATE clubs SET color = ? WHERE id = ?').run(color, clubId);
    }

    // Atomic like buyClubSlot: checks the buyer's balance and deducts it in
    // the same synchronous call that flips the flag, so a retry after a
    // false return can never double-charge. Idempotent by design (setting
    // color_unlocked = 1 again is harmless) — the caller is expected to
    // check club.colorUnlocked first so this never actually gets called
    // twice for the same club, but nothing breaks if it somehow did.
    function unlockClubColor(auth, clubId, cost) {
        if (getBalance(auth) < cost) return false;
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, balance)
                 VALUES (@auth, '', -@cost)
                 ON CONFLICT(auth) DO UPDATE SET balance = balance - @cost`
            )
            .run({ auth, cost });
        database.prepare('UPDATE clubs SET color_unlocked = 1 WHERE id = ?').run(clubId);
        return true;
    }

    // Direct write, no purchase logic — used by scripts/cap-club-slots.js
    // (a one-off migration clamping every club to the new CLUB_MAX_SLOTS,
    // refunding whatever was paid for slots above it via addCoins first)
    // and available for any future admin-side slot adjustment.
    function setClubSlots(clubId, slots) {
        database.prepare('UPDATE clubs SET slots = ? WHERE id = ?').run(slots, clubId);
    }

    function setClubEmoji(clubId, emoji) {
        database.prepare('UPDATE clubs SET emoji = ? WHERE id = ?').run(emoji, clubId);
    }

    // Atomic in the same sense as buyClubSlot/unlockClubColor: checks the
    // owner's balance and deducts it in the same synchronous call that
    // renames the club, so a retry after a false return can never
    // double-charge.
    function renameClub(auth, clubId, name, prefix, cost) {
        if (getBalance(auth) < cost) return false;
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, balance)
                 VALUES (@auth, '', -@cost)
                 ON CONFLICT(auth) DO UPDATE SET balance = balance - @cost`
            )
            .run({ auth, cost });
        database.prepare('UPDATE clubs SET name = ?, prefix = ? WHERE id = ?').run(name, prefix, clubId);
        return true;
    }

    // auth may be null to clear the assistant (e.g. !clubassistent with no
    // argument, or the caller clearing it after the assistant leaves/is
    // kicked — see commands/club.js).
    function setClubAssistant(clubId, auth) {
        database.prepare('UPDATE clubs SET assistant_auth = ? WHERE id = ?').run(auth, clubId);
    }

    // Atomic in the same sense as buyItem: checks the buyer's balance and
    // deducts it in the same synchronous call that grants the slot, so a
    // retry after a false return can never double-charge.
    function buyClubSlot(auth, clubId, cost) {
        if (getBalance(auth) < cost) return false;
        database
            .prepare(
                `INSERT INTO player_stats (auth, player_name, balance)
                 VALUES (@auth, '', -@cost)
                 ON CONFLICT(auth) DO UPDATE SET balance = balance - @cost`
            )
            .run({ auth, cost });
        database.prepare('UPDATE clubs SET slots = slots + 1 WHERE id = ?').run(clubId);
        return true;
    }

    // !tops clubs (see stats/print.js's buildClubRankingString) — called
    // once per player per completed match, same granularity as
    // savePlayerStats itself (see roomStats.js's updatePlayerStats), for
    // whichever club that player currently belongs to. A no-op call (all
    // three 0, e.g. a player who neither scored nor kept a clean sheet) is
    // skipped entirely rather than issuing a pointless UPDATE.
    function addClubStats(clubId, { goals = 0, assists = 0, cleanSheets = 0 } = {}) {
        if (goals === 0 && assists === 0 && cleanSheets === 0) return;
        database
            .prepare('UPDATE clubs SET goals = goals + ?, assists = assists + ?, clean_sheets = clean_sheets + ? WHERE id = ?')
            .run(goals, assists, cleanSheets, clubId);
    }

    // Ranked by combined score — goals + assists + clean_sheets, each
    // weighted equally (worth 1 apiece, no category outweighing another) —
    // NOT the same 5-entry quorum player leaderboards require (see
    // getLeaderboard/print.js's buildRankingString): clubs are a much
    // scarcer resource than players (coin-gated creation via !clubcreate),
    // so requiring 5 of them to exist would make this near-useless in a
    // typical room. A club that hasn't scored anything at all (score 0) is
    // excluded rather than padding the list with zeroes.
    function getTopClubs(limit) {
        return database
            .prepare(
                `SELECT id, name, prefix, emoji, goals, assists, clean_sheets AS cleanSheets,
                    (goals + assists + clean_sheets) AS score
                 FROM clubs
                 WHERE (goals + assists + clean_sheets) > 0
                 ORDER BY score DESC
                 LIMIT ?`
            )
            .all(limit);
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

    // core/stats/analytics/ — one row per player per match, see
    // match_analytics_reports' own doc comment above for why this is a JSON
    // payload rather than 28 dedicated columns.
    function saveMatchAnalyticsReport(report) {
        const payload = JSON.stringify(report);
        database
            .prepare('INSERT INTO match_analytics_reports (auth, player_name, payload) VALUES (?, ?, ?)')
            .run(report.auth, report.playerName, payload);
        return report;
    }

    // Ordered by `id DESC`, not `created_at DESC` — same same-second-tie
    // reasoning as getRecentRatingDelta above (a full match's worth of
    // reports lands within the same second).
    function getLatestMatchAnalyticsReport(auth) {
        const row = database
            .prepare('SELECT payload FROM match_analytics_reports WHERE auth = ? ORDER BY id DESC LIMIT 1')
            .get(auth);
        return row ? JSON.parse(row.payload) : null;
    }

    function close() {
        database.close();
    }

    return {
        init,
        getPlayerStats,
        getPlayerStatsByName,
        getStatRank,
        savePlayerStats,
        getLeaderboard,
        getPlayerStatsForSeed,
        setEloRating,
        getRating,
        saveRating,
        getRatingLeaderboard,
        saveRatingHistory,
        getRecentRatingDelta,
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
        createTelegramLinkCode,
        redeemTelegramLinkCode,
        linkTelegramId,
        getAuthByTelegramId,
        banAuth,
        unbanAuth,
        getAuthBan,
        getAuthBans,
        restrictCommand,
        unrestrictCommand,
        getCommandRestriction,
        getCommandRestrictions,
        backup,
        getSetting,
        setSetting,
        saveGameReport,
        saveMatchAnalyticsReport,
        getLatestMatchAnalyticsReport,
        addCoins,
        getBalance,
        spendCoins,
        claimDailyBonus,
        getOwnedItemIds,
        ownsItem,
        buyItem,
        getItemLevel,
        getItemOwners,
        setItemLevel,
        upgradeItem,
        setEquipped,
        getEquipped,
        getAllEquippedTrophies,
        setHideCustomColors,
        getAllHiddenCustomColors,
        setHiddenVip,
        getAllHiddenVipAuths,
        addSilence,
        removeSilence,
        getAllSilencedPairs,
        recordHeadToHead,
        getHeadToHead,
        getRecord,
        setRecord,
        setVipColor,
        getAllVipColors,
        getTopPlayers,
        getCurrentSeason,
        getSeasonTrophies,
        closeSeason,
        getClub,
        getAllClubs,
        getAllClubMembers,
        getClubMembers,
        getClubMembership,
        createClub,
        inviteToClub,
        getClubInvites,
        joinClub,
        removeClubMember,
        disbandClub,
        setClubColor,
        unlockClubColor,
        setClubSlots,
        setClubEmoji,
        renameClub,
        setClubAssistant,
        buyClubSlot,
        addClubStats,
        getTopClubs,
        close,
    };
}

module.exports = {
    createSqliteDatabase,
};
