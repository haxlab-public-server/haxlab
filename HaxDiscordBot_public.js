const path = require('path');

try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.warn('No .env file found — copy .env.example to .env and fill in your secrets.');
}

require('./src/core/discordProcess.js');
