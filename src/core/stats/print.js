/*
 * Formats one player's stat block for chat.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createPrintStats({
    getTimeStats,
}) {
    function printPlayerStats(stats) {
        return `${stats.playerName}: Игры: ${stats.games}, Победы: ${stats.wins} (${stats.winrate}), ` +
            `Время игры: ${getTimeStats(stats.playtime)}, Голы: ${stats.goals}, Ассисты: ${stats.assists}, ` +
            `Сухие матчи: ${stats.CS}, Автоголы: ${stats.ownGoals}`;
    }

    return {
        printPlayerStats,
    };
};
