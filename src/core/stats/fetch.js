/*
 * Builds the match summary embed sent to Discord after a game.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createFetchReports({
    Team,
    state,
    discordBot,
    roomName,
    findFirstNumberCharString,
    actionReportCountTeam,
    getGametimePlayer,
    getIdReport,
    getMinutesReport,
    getRecordingName,
    getSecondsReport,
    getTimeEmbed,
    db,
}) {
    function fetchGametimeReport(game) {
        const fieldGametimeRed = {
            name: '🔴        **RED TEAM STATS**',
            value: '⌛ __**Game Time:**__\n\n',
            inline: true,
        };
        const fieldGametimeBlue = {
            name: '🔵       **BLUE TEAM STATS**',
            value: '⌛ __**Game Time:**__\n\n',
            inline: true,
        };
        const redTeamTimes = game.playerComp[0].map((p) => [p.player, getGametimePlayer(p)]);
        const blueTeamTimes = game.playerComp[1].map((p) => [p.player, getGametimePlayer(p)]);

        for (let time of redTeamTimes) {
            const minutes = getMinutesReport(time[1]);
            const seconds = getSecondsReport(time[1]);
            fieldGametimeRed.value += `> **${time[0].name}:** ${minutes > 0 ? `${minutes}m` : ''}` +
                `${seconds > 0 || minutes == 0 ? `${seconds}s` : ''}\n`;
        }
        fieldGametimeRed.value += `\n${blueTeamTimes.length - redTeamTimes.length > 0 ? '\n'.repeat(blueTeamTimes.length - redTeamTimes.length) : ''
            }`;
        fieldGametimeRed.value += '=====================';

        for (let time of blueTeamTimes) {
            const minutes = getMinutesReport(time[1]);
            const seconds = getSecondsReport(time[1]);
            fieldGametimeBlue.value += `> **${time[0].name}:** ${minutes > 0 ? `${minutes}m` : ''}` +
                `${seconds > 0 || minutes == 0 ? `${seconds}s` : ''}\n`;
        }
        fieldGametimeBlue.value += `\n${redTeamTimes.length - blueTeamTimes.length > 0 ? '\n'.repeat(redTeamTimes.length - blueTeamTimes.length) : ''
            }`;
        fieldGametimeBlue.value += '=====================';

        return [fieldGametimeRed, fieldGametimeBlue];
    }

    function fetchActionsSummaryReport(game) {
        const fieldReportRed = {
            name: '🔴        **RED TEAM STATS**',
            value: '📊 __**Player Stats:**__\n\n',
            inline: true,
        };
        const fieldReportBlue = {
            name: '🔵       **BLUE TEAM STATS**',
            value: '📊 __**Player Stats:**__\n\n',
            inline: true,
        };
        const goals = [[], []];
        for (let i = 0; i < game.goals.length; i++) {
            goals[game.goals[i].team - 1].push([game.goals[i].striker, game.goals[i].assist]);
        }
        const redActions = actionReportCountTeam(goals, Team.RED);
        if (redActions.length > 0) {
            for (let act of redActions) {
                fieldReportRed.value += `> **${act[0].team != Team.RED ? '[OG] ' : ''}${act[0].name}:**` +
                    `${act[1] > 0 ? ` ${act[1]}G` : ''}` +
                    `${act[2] > 0 ? ` ${act[2]}A` : ''}` +
                    `${act[3] > 0 ? ` ${act[3]}CS` : ''}\n`;
            }
        }
        const blueActions = actionReportCountTeam(goals, Team.BLUE);
        if (blueActions.length > 0) {
            for (let act of blueActions) {
                fieldReportBlue.value += `> **${act[0].team != Team.BLUE ? '[OG] ' : ''}${act[0].name}:**` +
                    `${act[1] > 0 ? ` ${act[1]}G` : ''}` +
                    `${act[2] > 0 ? ` ${act[2]}A` : ''}` +
                    `${act[3] > 0 ? ` ${act[3]}CS` : ''}\n`;
            }
        }

        fieldReportRed.value += `\n${blueActions.length - redActions.length > 0 ? '\n'.repeat(blueActions.length - redActions.length) : ''
            }`;
        fieldReportRed.value += '=====================';

        fieldReportBlue.value += `\n${redActions.length - blueActions.length > 0 ? '\n'.repeat(redActions.length - blueActions.length) : ''
            }`;
        fieldReportBlue.value += '=====================';

        return [fieldReportRed, fieldReportBlue];
    }

    // core/stats/analytics/ !rating — every participant's per-match 0-10
    // rating, read back from the DB (already persisted by analyzeMatch()
    // inside entry.js's endGame(), which runs before onGameStop's deferred
    // room.stopGame() fires this) rather than threaded through as a param —
    // decouples this from analyzeMatch()'s exact call site/timing, same
    // "read the DB, don't thread the in-memory result" choice !rating itself
    // makes. Lists every participant (game.playerComp), not just scorers —
    // unlike fetchActionsSummaryReport, which only ever lists players with a
    // nonzero G/A/CS.
    async function fetchRatingsReport(game) {
        const fieldRatingsRed = { value: '⭐ __**Ratings:**__\n\n' };
        const fieldRatingsBlue = { value: '⭐ __**Ratings:**__\n\n' };

        for (const p of game.playerComp[0]) {
            const report = await db.getLatestMatchAnalyticsReport(p.auth);
            fieldRatingsRed.value += `> **${p.player.name}:** ${report != null ? report.rating.toFixed(1) : '—'}\n`;
        }
        fieldRatingsRed.value += `\n${game.playerComp[1].length - game.playerComp[0].length > 0 ? '\n'.repeat(game.playerComp[1].length - game.playerComp[0].length) : ''
            }`;
        fieldRatingsRed.value += '=====================';

        for (const p of game.playerComp[1]) {
            const report = await db.getLatestMatchAnalyticsReport(p.auth);
            fieldRatingsBlue.value += `> **${p.player.name}:** ${report != null ? report.rating.toFixed(1) : '—'}\n`;
        }
        fieldRatingsBlue.value += `\n${game.playerComp[0].length - game.playerComp[1].length > 0 ? '\n'.repeat(game.playerComp[0].length - game.playerComp[1].length) : ''
            }`;
        fieldRatingsBlue.value += '=====================';

        return [fieldRatingsRed, fieldRatingsBlue];
    }

    async function fetchSummaryEmbed(game) {
        const fetchEndgame = [fetchGametimeReport, fetchActionsSummaryReport, fetchRatingsReport];
        const fields = [
            {
                name: '🔴        **RED TEAM STATS**',
                value: '=====================\n\n',
                inline: true,
            },
            {
                name: '🔵       **BLUE TEAM STATS**',
                value: '=====================\n\n',
                inline: true,
            },
        ];
        for (let i = 0; i < fetchEndgame.length; i++) {
            // fetchGametimeReport/fetchActionsSummaryReport are plain sync
            // functions — awaiting a non-promise value just resolves to it
            // immediately, so this works uniformly across all three without
            // needing to special-case the one async report.
            const fieldsReport = await fetchEndgame[i](game);
            fields[0].value += fieldsReport[0].value + '\n\n';
            fields[1].value += fieldsReport[1].value + '\n\n';
        }
        fields[0].value = fields[0].value.substring(0, fields[0].value.length - 2);
        fields[1].value = fields[1].value.substring(0, fields[1].value.length - 2);

        const possR = state.possession[0] / (state.possession[0] + state.possession[1]);
        const possB = 1 - possR;
        const possRString = (possR * 100).toFixed(0).toString();
        const possBString = (possB * 100).toFixed(0).toString();
        const zoneR = state.actionZoneHalf[0] / (state.actionZoneHalf[0] + state.actionZoneHalf[1]);
        const zoneB = 1 - zoneR;
        const zoneRString = (zoneR * 100).toFixed(0).toString();
        const zoneBString = (zoneB * 100).toFixed(0).toString();
        const win = (game.scores.red > game.scores.blue) * 1 + (game.scores.blue > game.scores.red) * 2;
        discordBot.sendReport({
            title: `📝 MATCH REPORT #${getIdReport(roomName, findFirstNumberCharString)}`,
            description:
                `**${getTimeEmbed(game.scores.time)}** ` +
                (win == 1 ? '**Red Team** ' : 'Red Team ') + game.scores.red +
                ' - ' +
                game.scores.blue + (win == 2 ? ' **Blue Team**' : ' Blue Team') +
                '\n```c\nPossession: ' + possRString + '% - ' + possBString + '%' +
                '\nAction Zone: ' + zoneRString + '% - ' + zoneBString + '%\n```\n\n',
            color: 9567999,
            fields,
            footer: {
                text: `Recording: ${getRecordingName(game)}`,
            },
            timestamp: new Date().toISOString(),
        });
    }

    return {
        fetchGametimeReport,
        fetchActionsSummaryReport,
        fetchRatingsReport,
        fetchSummaryEmbed,
    };
};
