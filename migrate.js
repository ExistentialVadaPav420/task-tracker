// One-off migration: import existing data/tasks.json and data/people.json into SQLite.
// Safe to run once. Re-running will re-import tasks (replacing) and skip people that
// already exist by id. Usage: node migrate.js
const fs = require('fs');
const path = require('path');
const dbm = require('./db');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

const TASKS_FILE = path.join(__dirname, 'data', 'tasks.json');
const PEOPLE_FILE = path.join(__dirname, 'data', 'people.json');

const people = readJson(PEOPLE_FILE) || [];
const existingPeopleIds = new Set(dbm.getPeople().map(p => p.id));
let peopleAdded = 0;
for (const p of people) {
  if (existingPeopleIds.has(p.id)) continue;
  // Preserve original id by inserting directly.
  dbm.db.prepare('INSERT INTO people (id, name, email, is_app_user, linked_user_id) VALUES (?, ?, ?, 0, NULL)')
    .run(p.id, p.name, p.email || null);
  peopleAdded++;
}

const tasks = readJson(TASKS_FILE) || [];
if (tasks.length) {
  dbm.replaceAllTasks(tasks);
}

console.log(`Migration complete: ${tasks.length} tasks imported, ${peopleAdded} people added (of ${people.length} in file).`);
console.log(`DB now holds ${dbm.getTasks().length} tasks and ${dbm.getPeople().length} people.`);
