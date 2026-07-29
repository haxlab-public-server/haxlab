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

    // Generic key/value store for small bits of bot state that need to survive
    // a restart but don't warrant their own table — e.g. the Discord status
    // message ID, so the bot edits the same message instead of leaving a stale
    // one (with a dead room link) behind every time the process restarts.
    const settingsStatement = database.prepare(`
        CREATE TABLE IF NOT EXISTS bot_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    // Which shop items (see core/shopItems.js) a player owns — separate from
    // which one is currently equipped (player_stats.equipped_form/
    // equipped_goal_animation), so buying something doesn't have to also
    // wear it, and switching back to a previously-bought item never re-charges.
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
        discordLinksStatement.run();
        authBansStatement.run();
        addColumnIfMissing('auth_bans', 'expires_at TEXT');
        settingsStatement.run();
        playerItemsStatement.run();
        addColumnIfMissing('player_stats', 'balance INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing('player_stats', 'equipped_form TEXT');
        addColumnIfMissing('player_stats', 'equipped_goal_animation TEXT');
        addColumnIfMissing('player_stats', 'equipped_size TEXT');
        addColumnIfMissing('player_stats', 'equipped_trophy TEXT');
        clubsStatement.run();
        clubMembersStatement.run();
        clubInvitesStatement.run();
        addColumnIfMissing('clubs', 'emoji TEXT');
        addColumnIfMissing('clubs', 'assistant_auth TEXT');
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

    // slot is 'form', 'goalAnimation' or 'size' (validated by the caller,
    // core/economy.js, which is also the only place that knows the shop
    // catalog and can check ownership before calling this) or 'trophy'
    // (validated by core/commands/trophies.js the same way).
    const EQUIPPED_SLOT_COLUMNS = {
        form: 'equipped_form',
        goalAnimation: 'equipped_goal_animation',
        size: 'equipped_size',
        trophy: 'equipped_trophy',
    };

    function setEquipped(auth, slot, itemId) {
        const column = EQUIPPED_SLOT_COLUMNS[slot];
        database.prepare(`UPDATE player_stats SET ${column} = ? WHERE auth = ?`).run(itemId, auth);
    }

    function getEquipped(auth) {
        const row = database
            .prepare('SELECT equipped_form AS form, equipped_goal_animation AS goalAnimation, equipped_size AS size, equipped_trophy AS trophy FROM player_stats WHERE auth = ?')
            .get(auth);
        return row ? row : { form: null, goalAnimation: null, size: null, trophy: null };
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

    /* CLUBS */

    function rowToClub(row) {
        if (!row) return null;
        return { id: row.id, name: row.name, prefix: row.prefix, emoji: row.emoji, ownerAuth: row.ownerAuth, assistantAuth: row.assistantAuth, color: row.color, slots: row.slots };
    }

    const CLUB_COLUMNS = 'id, name, prefix, emoji, owner_auth AS ownerAuth, assistant_auth AS assistantAuth, color, slots';

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

    function setClubColor(clubId, color) {
        database.prepare('UPDATE clubs SET color = ? WHERE id = ?').run(color, clubId);
    }

    function setClubEmoji(clubId, emoji) {
        database.prepare('UPDATE clubs SET emoji = ? WHERE id = ?').run(emoji, clubId);
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
        getStatRank,
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
        getSetting,
        setSetting,
        saveGameReport,
        addCoins,
        getBalance,
        getOwnedItemIds,
        ownsItem,
        buyItem,
        setEquipped,
        getEquipped,
        getAllEquippedTrophies,
        getTopPlayers,
        getClub,
        getAllClubs,
        getAllClubMembers,
        getClubMembership,
        createClub,
        inviteToClub,
        getClubInvites,
        joinClub,
        removeClubMember,
        disbandClub,
        setClubColor,
        setClubEmoji,
        setClubAssistant,
        buyClubSlot,
        close,
    };
}

module.exports = {
    createSqliteDatabase,
};
