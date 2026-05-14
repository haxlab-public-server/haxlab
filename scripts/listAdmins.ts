#!/usr/bin/env node

import HaxballDatabase from '../src/db/Database';
try {
  const db = new HaxballDatabase();
  
  const admins = db.getPrivilegedPlayers();
  
  console.log('\n📋 Admins in database:\n');
  
  if (admins.length === 0) {
    console.log('   No admins found.\n');
    console.log('   Add admin using: node scripts/addAdmin.js <auth> <name> [role]');
  } else {
    console.log('   ID | Name                | Auth                 | Role    | Created');
    console.log('   ---|---------------------|----------------------|---------|-------------------');
    admins.forEach(admin => {
      const id = String(admin.id).padEnd(2);
      const name = String(admin.name).padEnd(19);
      const auth = String(admin.player_auth).padEnd(20);
      const role = String(admin.role).padEnd(7);
      const created = new Date(admin.created_at).toLocaleString();
      console.log(`   ${id} | ${name} | ${auth} | ${role} | ${created}`);
    });
    console.log('');
  }
  
  db.close();
} catch (err) {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
}
