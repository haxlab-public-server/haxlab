/*
 * haxball.js invokes room.onXxx handlers directly, with no try/catch of its
 * own — an uncaught error in any one of them (a bad command, an unexpected
 * null) would otherwise crash the whole process and end the game for every
 * player, not just whoever triggered it.
 */
module.exports = function wrapEventHandlers(handlers) {
    const wrapped = {};
    for (const [name, fn] of Object.entries(handlers)) {
        wrapped[name] = function (...args) {
            try {
                return fn.apply(this, args);
            } catch (err) {
                console.error(`Error in room.${name}:`, err);
            }
        };
    }
    return wrapped;
};
