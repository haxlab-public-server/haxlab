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
                const result = fn.apply(this, args);
                // An async fn never throws synchronously — any error inside
                // it (even one before its first await) surfaces only as a
                // rejected Promise, which the try/catch above can't see.
                // Left unhandled, that becomes a global unhandled rejection
                // instead of the per-handler log this wrapper exists to
                // provide, so it's caught here too.
                if (result instanceof Promise) {
                    result.catch((err) => console.error(`Error in room.${name}:`, err));
                }
                return result;
            } catch (err) {
                console.error(`Error in room.${name}:`, err);
            }
        };
    }
    return wrapped;
};
