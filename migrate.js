// One-off migration: copy existing local data into Postgres.
//
// Source of truth is the SQLite DB the app has run on since Step 1
// (data/tracker.db). If that file isn't present, falls back to the older
// data/tasks.json / data/people.json snapshot.
//
// Usage (needs DATABASE_URL pointing at a REACHABLE Postgres — use Render's
// EXTERNAL connection string when running locally, or run this from a Render
// shell where the internal URL resolves):
//     node migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dbm = require('./db');

const SQLITE_FILE = process.env.SQLITE_FILE || path.join(__dirname, 'data', 'tracker.db');
const TASKS_FILE = path.join(__dirname, 'data', 'tasks.json');
const PEOPLE_FILE = path.join(__dirname, 'data', 'people.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

// Pull users, people, and fully-hydrated tasks out of the legacy SQLite DB.
function readFromSqlite(file) {
  const Database = require('better-sqlite3');
  const sdb = new Database(file, { readonly: true, fileMustExist: true });
  const users = sdb.prepare('SELECT id, name, email, created_at FROM users').all();
  const people = sdb.prepare('SELECT id, name, email FROM people').all();
  const taskRows = sdb.prepare('SELECT * FROM tasks').all();
  const deps = sdb.prepare('SELECT task_id, depends_on_task_id FROM task_dependencies').all();
  const exts = sdb.prepare(
    'SELECT * FROM external_dependencies ORDER BY flagged_at DESC'
  ).all();
  sdb.close();

  const depMap = {};
  for (const d of deps) (depMap[d.task_id] = depMap[d.task_id] || []).push(d.depends_on_task_id);
  const extMap = {};
  for (const e of exts) if (!extMap[e.task_id]) extMap[e.task_id] = e; // first = latest (sorted desc)

  const tasks = taskRows.map(r => ({
    id: r.id, title: r.title, notes: r.notes || '', status: r.status, priority: r.priority,
    createdBy: r.created_by, assignedTo: r.assigned_to, createdAt: r.created_at, completedAt: r.completed_at,
    chain: r.chain ? JSON.parse(r.chain) : null,
    dependsOn: depMap[r.id] || [],
    externalDependency: extMap[r.id] ? {
      personId: extMap[r.id].person_id, note: extMap[r.id].note || '',
      flaggedAt: extMap[r.id].flagged_at, notifiedAt: extMap[r.id].notified_at, resolvedAt: extMap[r.id].resolved_at
    } : null
  }));
  return { users, people, tasks };
}

function readFromJson() {
  const people = (readJson(PEOPLE_FILE) || []).map(p => ({ id: p.id, name: p.name, email: p.email || null, created_at: null }));
  const tasks = readJson(TASKS_FILE) || [];
  return { users: [], people, tasks };
}

async function main() {
  let source;
  if (fs.existsSync(SQLITE_FILE)) {
    console.log(`Reading from SQLite: ${SQLITE_FILE}`);
    source = readFromSqlite(SQLITE_FILE);
  } else {
    console.log('No SQLite DB found — reading from tasks.json / people.json');
    source = readFromJson();
  }
  const { users, people, tasks } = source;

  await dbm.init();

  // Preserve original ids so task.assigned_to / created_by keep referencing the
  // right rows. ON CONFLICT keeps a re-run from duplicating.
  for (const u of users) {
    await dbm.pool.query(
      'INSERT INTO users (id, name, email, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
      [u.id, u.name, u.email || null, u.created_at || new Date().toISOString()]
    );
  }
  for (const p of people) {
    await dbm.pool.query(
      'INSERT INTO people (id, name, email, is_app_user, linked_user_id) VALUES ($1,$2,$3,FALSE,NULL) ON CONFLICT (id) DO NOTHING',
      [p.id, p.name, p.email || null]
    );
  }
  if (tasks.length) await dbm.replaceAllTasks(tasks);
  await dbm.syncPersonUserLinks();

  const finalTasks = await dbm.getTasks();
  const finalPeople = await dbm.getPeople();
  const finalUsers = await dbm.getUsers();
  console.log(`Migration complete: ${users.length} users, ${people.length} people, ${tasks.length} tasks imported.`);
  console.log(`Postgres now holds ${finalUsers.length} users, ${finalPeople.length} people, ${finalTasks.length} tasks.`);
  await dbm.pool.end();
}

main().catch((err) => {
  console.error('Migration failed', err);
  process.exit(1);
});
