/*
 * Captain-choice mode: picking players, slow mode countdown, captain leaving mid-choice.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createChoosingHelpers({
    room,
    state,
    Team,
    HaxNotification,
    announcementColor,
    errorColor,
    infoColor,
    warningColor,
    chooseModeSlowMode,
    chooseTime,
    defaultSlowMode,
    SMSet,
    getRandomInt,
}) {
    function activateChooseMode(isPreMatchDraft = false) {
        state.chooseMode = true;
        // Distinguishes the post-match WinStay refill draft (balance.js's
        // handlePlayersStop, before the next round's first kickoff) from a
        // live-match growth pick (balanceTeams(), mid-round) — only the
        // former gets the pre-match swap window once picking completes
        // (see balance.js's handlePlayersTeamChange completion branch).
        state.chooseModePreMatch = isPreMatchDraft;
        state.slowMode = chooseModeSlowMode;
        room.sendAnnouncement(
            `🐢 Время капитанов для выбора игроков: ${chooseModeSlowMode}s.`,
            null,
            announcementColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    function deactivateChooseMode() {
        state.chooseMode = false;
        clearTimeout(state.timeOutCap);
        if (state.slowMode != defaultSlowMode) {
            state.slowMode = defaultSlowMode;
            room.sendAnnouncement(
                `🐢 Время капитанов для выбора игроков: ${defaultSlowMode}s.`,
                null,
                announcementColor,
                'bold',
                HaxNotification.CHAT
            );
        }
        state.redCaptainChoice = '';
        state.blueCaptainChoice = '';
        state.chooseModePreMatch = false;
    }

    function getSpecList(player) {
        if (player == null) return null;
        let cstm = 'Игроки : ';
        for (let i = 0; i < state.teamSpec.length; i++) {
            cstm += state.teamSpec[i].name + `[${i + 1}], `;
        }
        cstm = cstm.substring(0, cstm.length - 2) + '.';
        room.sendAnnouncement(
            cstm,
            player.id,
            infoColor,
            'bold',
            HaxNotification.CHAT
        );
    }

    // Whoever fills an empty side becomes its captain, by construction (see
    // choosePlayer()/balance.js's handlePlayersLeave() below — both call
    // this rather than reading state.teamSpec[0] directly) — so !up
    // (commands/player.js) works by making THIS pick the VIP who claimed
    // state.priorityCaptainId instead of the front of the queue, once, then
    // clearing the claim either way (consumed, or found stale — the holder
    // left the spectator pool since claiming) so the next !up can be made.
    function resolveNextCaptainId() {
        let nextCaptainId = state.teamSpec[0].id;
        if (state.priorityCaptainId != null) {
            if (state.teamSpec.some((p) => p.id === state.priorityCaptainId)) {
                nextCaptainId = state.priorityCaptainId;
            }
            state.priorityCaptainId = null;
        }
        return nextCaptainId;
    }

    function choosePlayer() {
        clearTimeout(state.timeOutCap);
        // Bug: if one side is completely empty, neither branch below ever
        // assigns a captain (both require the side to be non-empty) —
        // captain stayed undefined, the whole announcement+timer block was
        // silently skipped, and getSpecList() below also never ran (it
        // requires BOTH sides non-empty). The room was left showing
        // activateChooseMode()'s "time to pick captains" announcement with
        // no captain ever actually prompted, stuck until an unrelated
        // join/leave/AFK toggle happened to deactivate choose mode via the
        // self-heal check elsewhere. There's nothing to "pick" for a side
        // with nobody on it anyway — auto-fill it with one waiting
        // spectator and let the resulting room.onPlayerTeamChange cascade
        // (-> handlePlayersTeamChange) re-evaluate from there, same as
        // every other roster change in this file.
        if ((state.teamRed.length == 0 || state.teamBlue.length == 0) && state.teamSpec.length > 0) {
            room.setPlayerTeam(resolveNextCaptainId(), state.teamRed.length == 0 ? Team.RED : Team.BLUE);
            return;
        }
        let captain;
        if (state.teamRed.length <= state.teamBlue.length && state.teamRed.length != 0) {
            captain = state.teamRed[0];
        } else if (state.teamBlue.length < state.teamRed.length && state.teamBlue.length != 0) {
            captain = state.teamBlue[0];
        }
        if (captain != null) {
            room.sendAnnouncement(
                "Для выбора игрока введите его номер из списка или используйте 'top', 'random' или 'bottom'.",
                captain.id,
                infoColor,
                'bold',
                HaxNotification.MENTION
            );
            state.timeOutCap = setTimeout(
                (player) => {
                    room.sendAnnouncement(
                        `Поторопись ${player.name}, осталось только ${Number.parseInt(String(chooseTime / 2))} секунд на выбор !`,
                        player.id,
                        warningColor,
                        'bold',
                        HaxNotification.MENTION
                    );
                    state.timeOutCap = setTimeout(
                        (player) => {
                            room.kickPlayer(
                                player.id,
                                "Вы не успели выбрать игрока !",
                                false
                            );
                        },
                        chooseTime * 500,
                        captain
                    );
                },
                chooseTime * 1000,
                captain
            );
        }
        if (state.teamRed.length != 0 && state.teamBlue.length != 0) {
            getSpecList(state.teamRed.length <= state.teamBlue.length ? state.teamRed[0] : state.teamBlue[0]);
        }
    }

    // None of the branches below call clearTimeout(state.timeOutCap)
    // themselves (the numeric-pick branch never did either) — room.setPlayerTeam
    // fires room.onPlayerTeamChange synchronously, which can recurse straight
    // back through handlePlayersTeamChange's own captain-choice auto-continue
    // (redCaptainChoice/blueCaptainChoice) and, if picking hands off to the
    // OTHER captain mid-cascade, call choosePlayer() for them — which sets a
    // BRAND NEW state.timeOutCap for their turn. Clearing the timer here,
    // AFTER setPlayerTeam has already returned from that whole cascade, would
    // wipe out that new timer instead of the stale one it was meant for.
    // handlePlayersTeamChange's own branches already clear/reset it correctly
    // on every path (an outright deactivateChooseMode(), or another
    // choosePlayer()), so there's nothing left for this function to do.
    function chooseModeFunction(player, message) {
        const msgArray = message.split(/ +/);
        if (player.id == state.teamRed[0].id || player.id == state.teamBlue[0].id) {
            if (state.teamRed.length <= state.teamBlue.length && player.id == state.teamRed[0].id) {
                // Bug: unlike the numeric-pick branch below (which already
                // bounds-checks against state.teamSpec.length), top/random/
                // bottom indexed straight into state.teamSpec with no
                // guard — reachable if a captain's message lands right as
                // teamSpec empties out from elsewhere, throwing instead of
                // reporting nothing left to pick.
                if (state.teamSpec.length == 0) {
                    return true;
                } else if (['top', 'auto'].includes(msgArray[0].toLowerCase())) {
                    room.setPlayerTeam(state.teamSpec[0].id, Team.RED);
                    state.redCaptainChoice = 'top';
                    room.sendAnnouncement(
                        `${player.name} выбрал Top !`,
                        null,
                        announcementColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                } else if (['random', 'rand'].includes(msgArray[0].toLowerCase())) {
                    const r = getRandomInt(state.teamSpec.length);
                    room.setPlayerTeam(state.teamSpec[r].id, Team.RED);
                    state.redCaptainChoice = 'random';
                    room.sendAnnouncement(
                        `${player.name} выбрал Random !`,
                        null,
                        announcementColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                } else if (['bottom', 'bot'].includes(msgArray[0].toLowerCase())) {
                    room.setPlayerTeam(state.teamSpec[state.teamSpec.length - 1].id, Team.RED);
                    state.redCaptainChoice = 'bottom';
                    room.sendAnnouncement(
                        `${player.name} выбрал Bottom !`,
                        null,
                        announcementColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                } else if (!Number.isNaN(Number.parseInt(msgArray[0]))) {
                    if (Number.parseInt(msgArray[0]) > state.teamSpec.length || Number.parseInt(msgArray[0]) < 1) {
                        room.sendAnnouncement(
                            `Ваш номер недействителен !`,
                            player.id,
                            errorColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    } else {
                        room.setPlayerTeam(
                            state.teamSpec[Number.parseInt(msgArray[0]) - 1].id,
                            Team.RED
                        );
                        room.sendAnnouncement(
                            `${player.name} выбрал ${state.teamSpec[Number.parseInt(msgArray[0]) - 1].name} !`,
                            null,
                            announcementColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    }
                } else return false;
                return true;
            }
            if (state.teamRed.length > state.teamBlue.length && player.id == state.teamBlue[0].id) {
                // See the identical guard/comment on the red branch above.
                if (state.teamSpec.length == 0) {
                    return true;
                } else if (['top', 'auto'].includes(msgArray[0].toLowerCase())) {
                    room.setPlayerTeam(state.teamSpec[0].id, Team.BLUE);
                    state.blueCaptainChoice = 'top';
                    room.sendAnnouncement(
                        `${player.name} выбрал Top !`,
                        null,
                        announcementColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                } else if (['random', 'rand'].includes(msgArray[0].toLowerCase())) {
                    room.setPlayerTeam(
                        state.teamSpec[getRandomInt(state.teamSpec.length)].id,
                        Team.BLUE
                    );
                    state.blueCaptainChoice = 'random';
                    room.sendAnnouncement(
                        `${player.name} выбрал Random !`,
                        null,
                        announcementColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                } else if (['bottom', 'bot'].includes(msgArray[0].toLowerCase())) {
                    room.setPlayerTeam(state.teamSpec[state.teamSpec.length - 1].id, Team.BLUE);
                    state.blueCaptainChoice = 'bottom';
                    room.sendAnnouncement(
                        `${player.name} выбрал Bottom !`,
                        null,
                        announcementColor,
                        'bold',
                        HaxNotification.CHAT
                    );
                } else if (!Number.isNaN(Number.parseInt(msgArray[0]))) {
                    if (Number.parseInt(msgArray[0]) > state.teamSpec.length || Number.parseInt(msgArray[0]) < 1) {
                        room.sendAnnouncement(
                            `Ваш номер недействителен !`,
                            player.id,
                            errorColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    } else {
                        room.setPlayerTeam(
                            state.teamSpec[Number.parseInt(msgArray[0]) - 1].id,
                            Team.BLUE
                        );
                        room.sendAnnouncement(
                            `${player.name} выбрал ${state.teamSpec[Number.parseInt(msgArray[0]) - 1].name} !`,
                            null,
                            announcementColor,
                            'bold',
                            HaxNotification.CHAT
                        );
                    }
                } else return false;
                return true;
            }
        }
    }

    function checkCaptainLeave(player) {
        if (
            (state.teamRed.findIndex((red) => red.id == player.id) == 0 && state.chooseMode && state.teamRed.length <= state.teamBlue.length) ||
            (state.teamBlue.findIndex((blue) => blue.id == player.id) == 0 && state.chooseMode && state.teamBlue.length < state.teamRed.length)
        ) {
            choosePlayer();
            state.capLeft = true;
            setTimeout(() => {
                state.capLeft = false;
            }, 10);
        }
    }

    function slowModeFunction(player, message) {
        if (!player.admin) {
            if (!SMSet.has(player.id)) {
                SMSet.add(player.id);
                setTimeout(
                    (number) => {
                        SMSet.delete(number);
                    },
                    state.slowMode * 1000,
                    player.id
                );
            } else {
                return true;
            }
        }
        return false;
    }

    return {
        activateChooseMode,
        deactivateChooseMode,
        getSpecList,
        choosePlayer,
        chooseModeFunction,
        checkCaptainLeave,
        slowModeFunction,
        resolveNextCaptainId,
    };
};
