#!/usr/bin/env node

import HaxballDatabase from '../src/db/Database';
const args = process.argv.slice(2);

if (args.length < 1) {
  console.log('Usage: node scripts/removeAdmin.js <player_auth>');
  console.log('Example: node scripts/removeAdmin.js "abc123def456"');
  process.exit(1);
}

const playerAuth = args[0];

try {
  const db = new HaxballDatabase();
  
  const existing = db.getPlayerByAuth(playerAuth);
  
  if (!existing) {
    console.log(`\n⚠️  Player with auth "${playerAuth}" not found in database`);
    db.close();
    process.exit(1);
  }
  
  console.log(`\nRemoving admin:`);
  console.log(`   Name: ${existing.name}`);
  console.log(`   Auth: ${existing.player_auth}`);
  console.log(`   Role: ${existing.role}`);
  
  // Set role to 'player' instead of deleting
  db.setPlayerRole(playerAuth, 'player');
  
  console.log(`\n✅ Role changed to "player" (admin rights removed)`);
  
  db.close();
} catch (err) {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
}
