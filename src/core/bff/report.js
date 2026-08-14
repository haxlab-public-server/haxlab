/*
 * BFF's own Discord match-summary embed — forked out of stats/fetch.js's
 * createFetchReports, not reused as-is: its fetchSummaryEmbed reads
 * state.possession/state.actionZoneHalf, which BFF's own endGame() (see
 * bffEntry.js's doc comment) deliberately never tracks. The two per-team
 * field builders below are otherwise identical to the main room's.
 *
 * Mutable room state is reached through `state`, never captured by value.
 */
module.exports = function createBffReport({
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

    function fetchSummaryEmbed(game) {
        const fetchEndgame = [fetchGametimeReport, fetchActionsSummaryReport];
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
            const fieldsReport = fetchEndgame[i](game);
            fields[0].value += fieldsReport[0].value + '\n\n';
            fields[1].value += fieldsReport[1].value + '\n\n';
        }
        fields[0].value = fields[0].value.substring(0, fields[0].value.length - 2);
        fields[1].value = fields[1].value.substring(0, fields[1].value.length - 2);

        const win = (game.scores.red > game.scores.blue) * 1 + (game.scores.blue > game.scores.red) * 2;
        discordBot.sendReport({
            title: `📝 MATCH REPORT #${getIdReport(roomName, findFirstNumberCharString)}`,
            description:
                `**${getTimeEmbed(game.scores.time)}** ` +
                (win == 1 ? '**Red Team** ' : 'Red Team ') + game.scores.red +
                ' - ' +
                game.scores.blue + (win == 2 ? ' **Blue Team**' : ' Blue Team') + '\n\n',
            color: 9567999,
            fields,
            footer: {
                text: `Recording: ${getRecordingName(game)}`,
            },
            timestamp: new Date().toISOString(),
        });
    }

    return {
        fetchSummaryEmbed,
    };
};
