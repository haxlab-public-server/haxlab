/*
 * Formats one player's stat block for chat.
 *
 * Mutable room state is reached through `state`, never captured by value:
 * those bindings are reassigned on every room event.
 */
module.exports = function createPrintStats({
    getTimeStats,
}) {
    // haxchill policy: play without obligations or a race for goals/wins/etc —
    // so only playtime is shown here. Everything else keeps being counted in
    // the database (see roomStats.js/playerStats.js), just not displayed.
    // Commented out rather than deleted, in case that policy changes:
    function printPlayerStats(stats) {
        let statsString = `${stats.playerName}: `;
        // for (let [key, value] of Object.entries(stats)) {
        //     if (key == 'playerName') continue;
        //     if (key == 'playtime') continue;
        //     let reCamelCase = /([A-Z](?=[a-z]+)|[A-Z]+(?![a-z]))/g;
        //     let statName = key.replaceAll(reCamelCase, ' $1').trim();
        //     statsString += `${statName.charAt(0).toUpperCase() + statName.slice(1)}: ${value}, `;
        // }
        statsString += `Время игры: ${getTimeStats(stats.playtime)}`;
        return statsString;
    }

    return {
        printPlayerStats,
    };
};
