/*
 * Formats one player's stat block for chat.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createPrintStats({
    getTimeStats,
    db,
}) {
    async function printPlayerStats(stats) {
        const goalsRank = await db.getStatRank('goals', stats.goals);
        const assistsRank = await db.getStatRank('assists', stats.assists);
        const csRank = await db.getStatRank('CS', stats.CS);
        const playtimeRank = await db.getStatRank('playtime', stats.playtime);
        return `${stats.playerName} ` +
            `[🏆 ${stats.winrate} побед, 🕹️ ${stats.games} игр] ` +
            `[🏅 Ранг по голам: ${goalsRank.rank}/${goalsRank.total}(${stats.goals}), ` +
            `ассистам: ${assistsRank.rank}/${assistsRank.total}(${stats.assists}), ` +
            `сухим матчам: ${csRank.rank}/${csRank.total}(${stats.CS}), ` +
            `времени игры: ${playtimeRank.rank}/${playtimeRank.total}(${getTimeStats(stats.playtime)})]`;
    }

    return {
        printPlayerStats,
    };
};
