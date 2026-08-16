/*
 * Player clubs: !club create/invite/join/etc, all routed through a single
 * !club <subcommand> dispatcher (see clubCommand/CLUB_SUBCOMMANDS at the
 * bottom) rather than one registered command per action — !help was getting
 * crowded with a dozen separate clubXxx entries. Every member gets the
 * club's prefix (and, if the owner set one, its color) in front of their
 * chat messages — see events/activity.js's onPlayerChat.
 *
 * state.clubs/state.clubMembers are an in-memory cache loaded once at
 * startup (see entry.js), same pattern as state.adminList/state.vipList —
 * every chat message would otherwise need a DB round trip just to find a
 * player's prefix. Every command below mutates this cache immediately
 * alongside its DB write, so the two never drift.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createClubCommands({
    room,
    state,
    authArray,
    db,
    announcementColor,
    errorColor,
    successColor,
    HaxNotification,
    formatCoins,
}) {
    const CLUB_CREATE_COST = 1000;
    const CLUB_BASE_SLOTS = 5;
    const CLUB_SLOT_BASE_COST = 500;
    const CLUB_SLOT_COST_STEP = 100;
    // Hard cap, confirmed 2026-08-14 — !club slots buy refuses past this
    // regardless of balance. Clubs that had already bought past 10 before
    // this existed were clamped down and refunded by a one-off migration
    // (see scripts/cap-club-slots.js), not silently left over the limit.
    const CLUB_MAX_SLOTS = 10;
    const CLUB_INVITE_DURATION_SECONDS = 60;
    const CLUB_COLOR_UNLOCK_COST = 10000;
    const CLUB_RENAME_COST = 500;

    // The displayed prefix is capped at "1 emoji + 4 letters/digits" — the
    // emoji is set separately (!club emoji), so what !club create/rename
    // takes here is just the 1-4 character part (no symbols/emoji).
    const CLUB_PREFIX_REGEX = /^[a-zA-Z0-9а-яА-ЯёЁ]{1,4}$/;
    // A single pictographic character, optionally followed by a variation
    // selector (U+FE0F) or joined into a ZWJ (U+200D) sequence — covers
    // most real emoji, including multi-codepoint ones like flags/skin
    // tones. Written with explicit \u escapes rather than the literal
    // invisible characters, so they stay visible/greppable in source.
    const CLUB_EMOJI_REGEX = new RegExp('^\\p{Extended_Pictographic}(\\uFE0F)?(\\u200D\\p{Extended_Pictographic}\\uFE0F?)*$', 'u');

    function getAuth(player) {
        return authArray[player.id][0];
    }

    function findClubByAuth(auth) {
        const membership = state.clubMembers.find((m) => m.auth === auth);
        if (!membership) return null;
        return state.clubs.find((c) => c.id === membership.clubId) ?? null;
    }

    // Same "[emoji][letters]" shape as the chat prefix in events/activity.js.
    function clubTag(club) {
        return `[${club.emoji ?? ''}${club.prefix}]`;
    }

    // Price of the NEXT slot this club buys — 500 for the first purchase
    // (slots going 5 -> 6), +100 for every one bought since.
    function nextSlotCost(club) {
        return CLUB_SLOT_BASE_COST + CLUB_SLOT_COST_STEP * (club.slots - CLUB_BASE_SLOTS);
    }

    function announceError(player, text) {
        room.sendAnnouncement(text, player.id, errorColor, 'bold', HaxNotification.CHAT);
    }

    function resolveTarget(target) {
        if (target[0] === '#') {
            const id = parseInt(target.substring(1));
            const targetPlayer = state.playersAll.find((p) => p.id === id);
            if (!targetPlayer) return null;
            return { auth: getAuth(targetPlayer), name: targetPlayer.name, player: targetPlayer };
        }
        const targetPlayer = state.playersAll.find((p) => getAuth(p) === target);
        return { auth: target, name: targetPlayer ? targetPlayer.name : target, player: targetPlayer ?? null };
    }

    async function clubCreateCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const [name, prefix] = msgArray;
        if (!name || !prefix) {
            announceError(player, `Использование: !club create <название> <префикс>. Пример: !club create Falcons FLC. Введите "!club help" для информации.`);
            return;
        }
        if (!CLUB_PREFIX_REGEX.test(prefix)) {
            announceError(player, `Префикс должен состоять из 1-4 букв и/или цифр (без символов и эмодзи). Эмодзи можно добавить отдельно командой "!club emoji". Пример: !club create Falcons FLC.`);
            return;
        }
        const auth = getAuth(player);
        if (findClubByAuth(auth)) {
            announceError(player, `Вы уже состоите в клубе !`);
            return;
        }
        const club = await db.createClub(auth, player.name, name, prefix, CLUB_CREATE_COST);
        if (!club) {
            const balance = await db.getBalance(auth);
            announceError(player, `Недостаточно монет. Нужно ${formatCoins(CLUB_CREATE_COST)}, у вас ${formatCoins(balance)}.`);
            return;
        }
        state.clubs.push(club);
        state.clubMembers.push({ auth, clubId: club.id, playerName: player.name });
        room.sendAnnouncement(
            `🏆 Клуб "${club.name}" ${clubTag(club)} создан ! Приглашайте игроков командой "!club invite".`,
            player.id,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function clubRenameCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const [name, prefix] = msgArray;
        if (!name || !prefix) {
            announceError(player, `Использование: !club rename <название> <префикс> (${formatCoins(CLUB_RENAME_COST)}). Пример: !club rename Falcons FLC2.`);
            return;
        }
        if (!CLUB_PREFIX_REGEX.test(prefix)) {
            announceError(player, `Префикс должен состоять из 1-4 букв и/или цифр (без символов и эмодзи). Эмодзи можно добавить отдельно командой "!club emoji". Пример: !club rename Falcons FLC2.`);
            return;
        }
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе !`);
            return;
        }
        if (club.ownerAuth !== auth) {
            announceError(player, `Только владелец клуба может переименовать его !`);
            return;
        }
        const renamed = await db.renameClub(auth, club.id, name, prefix, CLUB_RENAME_COST);
        if (!renamed) {
            const balance = await db.getBalance(auth);
            announceError(player, `Недостаточно монет. Нужно ${formatCoins(CLUB_RENAME_COST)}, у вас ${formatCoins(balance)}.`);
            return;
        }
        const oldName = club.name;
        club.name = name;
        club.prefix = prefix;
        room.sendAnnouncement(
            `🏆 Клуб "${oldName}" переименован в "${club.name}" ${clubTag(club)} !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function clubInviteCommand(player, message) {
        const target = message.split(/ +/)[1];
        if (!target || target[0] !== '#') {
            announceError(player, `Использование: !club invite #<id>. Введите "!club help" для информации.`);
            return;
        }
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе !`);
            return;
        }
        if (club.ownerAuth !== auth && club.assistantAuth !== auth) {
            announceError(player, `Только владелец или ассистент клуба может приглашать игроков !`);
            return;
        }
        const resolved = resolveTarget(target);
        if (!resolved || !resolved.player) {
            announceError(player, `Такого игрока нет в комнате.`);
            return;
        }
        if (findClubByAuth(resolved.auth)) {
            announceError(player, `Этот игрок уже состоит в клубе !`);
            return;
        }
        const memberCount = state.clubMembers.filter((m) => m.clubId === club.id).length;
        if (memberCount >= club.slots) {
            announceError(player, `В клубе нет свободных слотов ! Купите слот командой "!club slots buy".`);
            return;
        }
        await db.inviteToClub(club.id, resolved.auth, CLUB_INVITE_DURATION_SECONDS);
        room.sendAnnouncement(
            `${player.name} пригласил ${resolved.name} в клуб "${club.name}" !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
        room.sendAnnouncement(
            `Вы были приглашены в клуб "${club.name}". У вас есть ${CLUB_INVITE_DURATION_SECONDS} секунд чтобы принять приглашение (!club join)`,
            resolved.player.id,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function clubJoinCommand(player, message) {
        const auth = getAuth(player);
        if (findClubByAuth(auth)) {
            announceError(player, `Вы уже состоите в клубе !`);
            return;
        }
        const invites = await db.getClubInvites(auth);
        if (invites.length === 0) {
            announceError(player, `У вас нет приглашений в клуб.`);
            return;
        }
        let invite = invites[0];
        if (invites.length > 1) {
            const wanted = message.split(/ +/).slice(1).join(' ').toLowerCase();
            if (!wanted) {
                const list = invites.map((i) => `"${i.clubName}" [${i.clubEmoji ?? ''}${i.clubPrefix}]`).join(', ');
                announceError(player, `У вас несколько приглашений: ${list}. Введите "!club join <название клуба>" чтобы выбрать.`);
                return;
            }
            const found = invites.find((i) => i.clubName.toLowerCase() === wanted);
            if (!found) {
                announceError(player, `Приглашение от клуба "${message.split(/ +/).slice(1).join(' ')}" не найдено.`);
                return;
            }
            invite = found;
        }
        const joined = await db.joinClub(auth, player.name, invite.clubId);
        if (!joined) {
            announceError(player, `Не удалось вступить в клуб — возможно, в нем закончились свободные места.`);
            return;
        }
        state.clubMembers.push({ auth, clubId: invite.clubId, playerName: player.name });
        room.sendAnnouncement(
            `🏆 ${player.name} вступил в клуб "${invite.clubName}" [${invite.clubEmoji ?? ''}${invite.clubPrefix}] !`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    async function clubLeaveCommand(player, message) {
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе !`);
            return;
        }
        if (club.ownerAuth === auth) {
            announceError(player, `Владелец не может покинуть свой клуб — используйте "!club disband" чтобы расформировать его.`);
            return;
        }
        await db.removeClubMember(auth);
        state.clubMembers = state.clubMembers.filter((m) => m.auth !== auth);
        if (club.assistantAuth === auth) {
            await db.setClubAssistant(club.id, null);
            club.assistantAuth = null;
        }
        room.sendAnnouncement(`${player.name} покинул клуб "${club.name}" !`, null, announcementColor, 'bold', HaxNotification.CHAT);
    }

    async function clubKickCommand(player, message) {
        const target = message.split(/ +/)[1];
        if (!target) {
            announceError(player, `Использование: !club kick <#id|auth>.`);
            return;
        }
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе !`);
            return;
        }
        if (club.ownerAuth !== auth) {
            announceError(player, `Только владелец клуба может выгонять из него !`);
            return;
        }
        const resolved = resolveTarget(target);
        if (!resolved) {
            announceError(player, `Такого игрока нет в комнате.`);
            return;
        }
        if (resolved.auth === auth) {
            announceError(player, `Вы не можете выгнать самого себя — используйте "!club disband".`);
            return;
        }
        const membership = state.clubMembers.find((m) => m.auth === resolved.auth && m.clubId === club.id);
        if (!membership) {
            announceError(player, `Этот игрок не состоит в вашем клубе.`);
            return;
        }
        await db.removeClubMember(resolved.auth);
        state.clubMembers = state.clubMembers.filter((m) => m.auth !== resolved.auth);
        if (club.assistantAuth === resolved.auth) {
            await db.setClubAssistant(club.id, null);
            club.assistantAuth = null;
        }
        room.sendAnnouncement(`${resolved.name} выгнан из клуба "${club.name}" !`, null, announcementColor, 'bold', HaxNotification.CHAT);
    }

    // The assistant is the one non-owner role a club has — its only extra
    // power over a plain member is being allowed to !club invite (see the
    // ownership check up there). One assistant per club; naming a new one
    // replaces whoever held it before. Target can be #<id> (online) or an
    // exact (case-insensitive) member name (offline members are still
    // eligible — they just can't be resolved through #<id>).
    async function clubAssistantCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе !`);
            return;
        }
        if (club.ownerAuth !== auth) {
            announceError(player, `Только владелец клуба может назначать ассистента !`);
            return;
        }
        if (msgArray.length === 0) {
            await db.setClubAssistant(club.id, null);
            club.assistantAuth = null;
            room.sendAnnouncement(`✔️ Ассистент клуба "${club.name}" снят !`, player.id, successColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const target = msgArray[0];
        let targetAuth, targetName;
        if (target[0] === '#') {
            const resolved = resolveTarget(target);
            if (!resolved || !resolved.player) {
                announceError(player, `Такого игрока нет в комнате.`);
                return;
            }
            targetAuth = resolved.auth;
            targetName = resolved.name;
        } else {
            const wanted = msgArray.join(' ').toLowerCase();
            const member = state.clubMembers.find((m) => m.clubId === club.id && m.playerName.toLowerCase() === wanted);
            if (!member) {
                announceError(player, `Такого игрока нет в вашем клубе.`);
                return;
            }
            targetAuth = member.auth;
            targetName = member.playerName;
        }
        if (targetAuth === club.ownerAuth) {
            announceError(player, `Владелец не может быть ассистентом своего же клуба.`);
            return;
        }
        const membership = state.clubMembers.find((m) => m.auth === targetAuth && m.clubId === club.id);
        if (!membership) {
            announceError(player, `Этот игрок не состоит в вашем клубе.`);
            return;
        }
        await db.setClubAssistant(club.id, targetAuth);
        club.assistantAuth = targetAuth;
        room.sendAnnouncement(`✔️ ${targetName} теперь ассистент клуба "${club.name}" !`, null, announcementColor, 'bold', HaxNotification.CHAT);
    }

    async function clubDisbandCommand(player, message) {
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе !`);
            return;
        }
        if (club.ownerAuth !== auth) {
            announceError(player, `Только владелец клуба может расформировать его !`);
            return;
        }
        await db.disbandClub(club.id);
        state.clubMembers = state.clubMembers.filter((m) => m.clubId !== club.id);
        state.clubs = state.clubs.filter((c) => c.id !== club.id);
        room.sendAnnouncement(`Клуб "${club.name}" был расформирован !`, null, announcementColor, 'bold', HaxNotification.CHAT);
    }

    // "!club color buy" unlocks custom colors for the club (permanently,
    // once — not per-color-change), "!club color <hex>" sets one (requires
    // the unlock first). Merged into one subcommand since "buy" can never be
    // mistaken for a real hex value (u/y aren't hex digits), so there's no
    // ambiguity routing on the first argument alone.
    async function clubColorCommand(player, message) {
        const arg = message.split(/ +/)[1];
        if ((arg ?? '').toLowerCase() === 'buy') {
            const auth = getAuth(player);
            const club = findClubByAuth(auth);
            if (!club) {
                announceError(player, `Вы не состоите в клубе !`);
                return;
            }
            if (club.ownerAuth !== auth) {
                announceError(player, `Только владелец клуба может покупать эту возможность !`);
                return;
            }
            if (club.colorUnlocked) {
                announceError(player, `Кастомный цвет уже разблокирован для вашего клуба !`);
                return;
            }
            const unlocked = await db.unlockClubColor(auth, club.id, CLUB_COLOR_UNLOCK_COST);
            if (!unlocked) {
                const balance = await db.getBalance(auth);
                announceError(player, `Недостаточно монет. Нужно ${formatCoins(CLUB_COLOR_UNLOCK_COST)}, у вас ${formatCoins(balance)}.`);
                return;
            }
            club.colorUnlocked = true;
            room.sendAnnouncement(
                `✔️ Кастомный цвет разблокирован для клуба "${club.name}" ! Установите его командой "!club color <hex>".`,
                player.id,
                successColor,
                'bold',
                HaxNotification.CHAT
            );
            return;
        }

        if (!arg || !/^[0-9a-fA-F]{1,6}$/.test(arg)) {
            announceError(player, `Использование: !club color <hex>, или !club color buy — разблокировать кастомный цвет клуба (${formatCoins(CLUB_COLOR_UNLOCK_COST)}). Пример: !club color ff8800.`);
            return;
        }
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе !`);
            return;
        }
        if (club.ownerAuth !== auth) {
            announceError(player, `Только владелец клуба может менять его цвет !`);
            return;
        }
        if (!club.colorUnlocked) {
            announceError(player, `Кастомный цвет клуба — платная возможность. Купите ее командой "!club color buy" (${formatCoins(CLUB_COLOR_UNLOCK_COST)}).`);
            return;
        }
        const color = parseInt(arg, 16);
        await db.setClubColor(club.id, color);
        club.color = color;
        room.sendAnnouncement(`✔️ Цвет клуба "${club.name}" обновлен !`, player.id, successColor, 'bold', HaxNotification.CHAT);
    }

    // The prefix itself (!club create) is letters-only — the emoji in front
    // of it (making up the "1 emoji + 4 letters" displayed tag) is set here,
    // separately, so a club can go without one entirely.
    async function clubEmojiCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе !`);
            return;
        }
        if (club.ownerAuth !== auth) {
            announceError(player, `Только владелец клуба может менять эмодзи !`);
            return;
        }
        if (msgArray.length === 0) {
            await db.setClubEmoji(club.id, null);
            club.emoji = null;
            room.sendAnnouncement(`✔️ Эмодзи клуба "${club.name}" убран !`, player.id, successColor, 'bold', HaxNotification.CHAT);
            return;
        }
        const emoji = msgArray[0];
        if (!CLUB_EMOJI_REGEX.test(emoji)) {
            announceError(player, `Использование: !club emoji <эмодзи>. Пример: !club emoji 🔥. Введите "!club emoji" без аргумента, чтобы убрать эмодзи.`);
            return;
        }
        await db.setClubEmoji(club.id, emoji);
        club.emoji = emoji;
        room.sendAnnouncement(`✔️ Эмодзи клуба "${club.name}" обновлен !`, player.id, successColor, 'bold', HaxNotification.CHAT);
    }

    async function clubSlotsCommand(player, message) {
        const sub = message.split(/ +/)[1];
        if ((sub ?? '').toLowerCase() !== 'buy') {
            announceError(player, `Использование: !club slots buy — купить дополнительный слот. Введите "!club help" для информации.`);
            return;
        }
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе !`);
            return;
        }
        if (club.ownerAuth !== auth) {
            announceError(player, `Только владелец клуба может покупать слоты !`);
            return;
        }
        if (club.slots >= CLUB_MAX_SLOTS) {
            announceError(player, `Достигнут максимум слотов (${CLUB_MAX_SLOTS}) !`);
            return;
        }
        const cost = nextSlotCost(club);
        const bought = await db.buyClubSlot(auth, club.id, cost);
        if (!bought) {
            const balance = await db.getBalance(auth);
            announceError(player, `Недостаточно монет. Нужно ${formatCoins(cost)}, у вас ${formatCoins(balance)}.`);
            return;
        }
        club.slots += 1;
        room.sendAnnouncement(
            `✔️ Куплен новый слот за ${formatCoins(cost)} ! Теперь в клубе "${club.name}" ${club.slots} слотов.`,
            player.id,
            successColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    // "<название> (игроки/лимит): <капитан> (c), <ассистент> (a), <игрок1>..."
    // — captain and assistant (if any) always listed first, in that order,
    // the rest in join order.
    function clubInfoCommand(player, message) {
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе ! Создайте свой командой "!club create", или дождитесь приглашения.`);
            return;
        }
        const members = state.clubMembers.filter((m) => m.clubId === club.id);
        const captain = members.find((m) => m.auth === club.ownerAuth);
        const assistant = club.assistantAuth ? members.find((m) => m.auth === club.assistantAuth) : null;
        const rest = members.filter((m) => m.auth !== club.ownerAuth && m.auth !== club.assistantAuth);
        const entries = [];
        if (captain) entries.push(`${captain.playerName} (c)`);
        if (assistant) entries.push(`${assistant.playerName} (a)`);
        entries.push(...rest.map((m) => m.playerName));
        // A club that paid to unlock + set a custom color (!club color,
        // colorUnlocked-gated — see clubColorCommand) previously only ever
        // saw it in chat prefixes (events/activity.js); this is its own
        // "!club" info display, so it should show it too, not the flat
        // neutral color every other announcement uses. `club.color` is
        // nullable (never set, or unlocked-but-not-yet-picked) — falls back
        // to the usual announcementColor exactly like an un-set custom color
        // already does everywhere else.
        room.sendAnnouncement(
            `${club.name} (${members.length}/${club.slots}): ${entries.join(', ')}`,
            player.id,
            club.color ?? announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    // !cc <message> — same idea as !x/teamChat (chat.js), just addressed to
    // the sender's whole club instead of their current team: every club
    // member currently online (state.playersAll — regardless of team or
    // spectator status, unlike teamChat) gets a private sendAnnouncement,
    // not a single broadcast. Offline members obviously can't receive
    // anything; there's no mailbox/history for them to catch up on later.
    function clubChatCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const auth = getAuth(player);
        const club = findClubByAuth(auth);
        if (!club) {
            announceError(player, `Вы не состоите в клубе !`);
            return;
        }
        const text = `${clubTag(club)} [CC] ${player.name}: ${msgArray.join(' ')}`;
        const memberAuths = new Set(state.clubMembers.filter((m) => m.clubId === club.id).map((m) => m.auth));
        for (const online of state.playersAll.filter((p) => memberAuths.has(getAuth(p)))) {
            room.sendAnnouncement(text, online.id, announcementColor, 'bold', HaxNotification.CHAT);
        }
    }

    function clubHelpCommand(player, message) {
        const text = [
            '🏆 Команды клуба (!club <команда>):',
            `!club show — показать информацию о вашем клубе (по умолчанию — то же самое, что и без аргумента "!club").`,
            `!club create <название> <префикс> — создать клуб (${formatCoins(CLUB_CREATE_COST)}). Префикс — 1-4 буквы и/или цифры. Пример: !club create Falcons FLC.`,
            `!club rename <название> <префикс> — переименовать клуб (${formatCoins(CLUB_RENAME_COST)}, только владелец). Пример: !club rename Falcons FLC2.`,
            `!club invite #<id> — пригласить игрока в клуб (владелец и ассистент). У приглашения есть ${CLUB_INVITE_DURATION_SECONDS} секунд на принятие.`,
            '!club join [название] — принять приглашение в клуб.',
            '!club leave — покинуть клуб.',
            '!club kick <#id|auth> — выгнать игрока из клуба (только владелец).',
            '!club assistant <игрок> — назначить ассистента клуба, или без аргумента чтобы снять его (только владелец). У ассистента есть доступ только к приглашениям игроков.',
            '!club disband — расформировать клуб (только владелец).',
            `!club color buy — разблокировать кастомный цвет клуба (${formatCoins(CLUB_COLOR_UNLOCK_COST)}, только владелец, разовая покупка).`,
            '!club color <hex> — изменить цвет префикса клуба в чате (только владелец, требует "!club color buy"). Пример: !club color ff8800.',
            '!club emoji <эмодзи> — добавить эмодзи к префиксу клуба, или без аргумента чтобы убрать его (только владелец). Пример: !club emoji 🔥.',
            `!club slots buy - купить слот (500 монеток, +100 за каждый следующий, максимум ${CLUB_MAX_SLOTS}) (только владелец).`,
            '!cc <сообщение> — клубный чат: отправляет сообщение всем участникам вашего клуба, которые сейчас на сервере. Пример: !cc привет!',
            '!club help — эта команда.',
        ].join('\n');
        // 'italic' (requested 2026-08-16) — reference text, not an event or
        // a warning, same reasoning as bff/commands.js's own !rules.
        room.sendAnnouncement(text, player.id, announcementColor, 'italic', HaxNotification.CHAT);
    }

    // Every !clubXxx command used to be its own registered top-level command
    // — !help got crowded with a dozen near-identical "смотрите !clubhelp"
    // entries. Routed through one dispatcher instead: !club <subcommand>
    // <rest...>. Each handler below still parses its OWN args the exact same
    // way it always did (message.split(/ +/).slice(1)), so the dispatcher
    // just needs to hand it a message whose slice(1) reproduces `rest` — the
    // literal first token it rebuilds ('!club') is never looked at, only
    // dropped, so it doesn't matter that it's not the real subcommand word.
    // 'assistant'/'assistent' both map to the same handler — the in-game
    // command was historically misspelled and old muscle memory shouldn't
    // suddenly stop working now that it's a subcommand instead of a whole
    // command name.
    const CLUB_SUBCOMMANDS = {
        show: clubInfoCommand,
        create: clubCreateCommand,
        rename: clubRenameCommand,
        invite: clubInviteCommand,
        join: clubJoinCommand,
        leave: clubLeaveCommand,
        kick: clubKickCommand,
        assistant: clubAssistantCommand,
        assistent: clubAssistantCommand,
        disband: clubDisbandCommand,
        color: clubColorCommand,
        emoji: clubEmojiCommand,
        slots: clubSlotsCommand,
        help: clubHelpCommand,
    };

    async function clubCommand(player, message) {
        const msgArray = message.split(/ +/).slice(1);
        const sub = (msgArray[0] ?? 'show').toLowerCase();
        const handler = CLUB_SUBCOMMANDS[sub];
        if (!handler) {
            announceError(player, `Неизвестная подкоманда "${sub}". Введите "!club help" для списка.`);
            return;
        }
        await handler(player, ['!club', ...msgArray.slice(1)].join(' '));
    }

    return {
        clubCommand,
        clubChatCommand,
        clubCreateCommand,
        clubRenameCommand,
        clubInviteCommand,
        clubJoinCommand,
        clubLeaveCommand,
        clubKickCommand,
        clubAssistantCommand,
        clubDisbandCommand,
        clubColorCommand,
        clubEmojiCommand,
        clubSlotsCommand,
        clubInfoCommand,
        clubHelpCommand,
    };
};
