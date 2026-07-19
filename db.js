const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'tracker.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS people (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    email          TEXT,
    is_app_user    INTEGER NOT NULL DEFAULT 0,
    linked_user_id TEXT
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    notes        TEXT,
    status       TEXT NOT NULL DEFAULT 'todo',
    priority     TEXT NOT NULL DEFAULT 'medium',
    created_by   TEXT,
    assigned_to  TEXT,
    created_at   TEXT,
    completed_at TEXT,
    chain        TEXT
  );

  CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id            TEXT NOT NULL,
    depends_on_task_id TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id)
  );

  CREATE TABLE IF NOT EXISTS external_dependencies (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    person_id   TEXT,
    note        TEXT,
    flagged_at  TEXT,
    notified_at TEXT,
    resolved_at TEXT
  );
`);

function newId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 10);
}

// --- Assemble a task row into the object shape the frontend expects ---

const depsStmt = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?');
const extStmt = db.prepare('SELECT * FROM external_dependencies WHERE task_id = ? ORDER BY flagged_at DESC LIMIT 1');

function mapExternal(row) {
  if (!row) return null;
  return {
    personId: row.person_id,
    note: row.note || '',
    flaggedAt: row.flagged_at,
    notifiedAt: row.notified_at,
    resolvedAt: row.resolved_at
  };
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    notes: row.notes || '',
    status: row.status,
    priority: row.priority,
    createdBy: row.created_by,
    assignedTo: row.assigned_to,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    dependsOn: depsStmt.all(row.id).map(r => r.depends_on_task_id),
    externalDependency: mapExternal(extStmt.get(row.id)),
    chain: row.chain ? JSON.parse(row.chain) : null
  };
}

function getTasks() {
  return db.prepare('SELECT * FROM tasks').all().map(hydrate);
}

function getTask(id) {
  return hydrate(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

// --- Bulk replace (Step 1: preserves the existing PUT /api/tasks contract) ---

const clearTasks = db.prepare('DELETE FROM tasks');
const clearDeps = db.prepare('DELETE FROM task_dependencies');
const clearExt = db.prepare('DELETE FROM external_dependencies');
const insertTask = db.prepare(`
  INSERT INTO tasks (id, title, notes, status, priority, created_by, assigned_to, created_at, completed_at, chain)
  VALUES (@id, @title, @notes, @status, @priority, @created_by, @assigned_to, @created_at, @completed_at, @chain)
`);
const insertDep = db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)');
const insertExt = db.prepare(`
  INSERT INTO external_dependencies (id, task_id, person_id, note, flagged_at, notified_at, resolved_at)
  VALUES (@id, @task_id, @person_id, @note, @flagged_at, @notified_at, @resolved_at)
`);

function taskToRow(t) {
  return {
    id: t.id || newId('t'),
    title: t.title,
    notes: t.notes || null,
    status: t.status || 'todo',
    priority: t.priority || 'medium',
    created_by: t.createdBy || null,
    assigned_to: t.assignedTo || null,
    created_at: t.createdAt || new Date().toISOString(),
    completed_at: t.completedAt || null,
    chain: t.chain ? JSON.stringify(t.chain) : null
  };
}

const replaceAllTasks = db.transaction((tasks) => {
  clearExt.run();
  clearDeps.run();
  clearTasks.run();
  for (const t of tasks) {
    const row = taskToRow(t);
    insertTask.run(row);
    for (const depId of (t.dependsOn || [])) insertDep.run(row.id, depId);
    if (t.externalDependency) {
      const e = t.externalDependency;
      insertExt.run({
        id: newId('e'),
        task_id: row.id,
        person_id: e.personId || null,
        note: e.note || null,
        flagged_at: e.flaggedAt || null,
        notified_at: e.notifiedAt || null,
        resolved_at: e.resolvedAt || null
      });
    }
  }
});

// --- Granular task writes (used from Step 3 onward) ---

function createTask(t) {
  const row = taskToRow(t);
  const write = db.transaction(() => {
    insertTask.run(row);
    for (const depId of (t.dependsOn || [])) insertDep.run(row.id, depId);
  });
  write();
  return getTask(row.id);
}

const updateTaskStmt = db.prepare(`
  UPDATE tasks SET title=@title, notes=@notes, status=@status, priority=@priority,
    assigned_to=@assigned_to, completed_at=@completed_at
  WHERE id=@id
`);

function updateTask(id, fields) {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) return null;
  const merged = {
    id,
    title: fields.title !== undefined ? fields.title : existing.title,
    notes: fields.notes !== undefined ? (fields.notes || null) : existing.notes,
    status: fields.status !== undefined ? fields.status : existing.status,
    priority: fields.priority !== undefined ? fields.priority : existing.priority,
    assigned_to: fields.assignedTo !== undefined ? (fields.assignedTo || null) : existing.assigned_to,
    completed_at: fields.completedAt !== undefined ? fields.completedAt : existing.completed_at
  };
  const write = db.transaction(() => {
    updateTaskStmt.run(merged);
    if (fields.dependsOn !== undefined) {
      db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(id);
      for (const depId of fields.dependsOn) insertDep.run(id, depId);
    }
  });
  write();
  return getTask(id);
}

const deleteTaskTxn = db.transaction((id) => {
  db.prepare('DELETE FROM external_dependencies WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?').run(id, id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
});
function deleteTask(id) { deleteTaskTxn(id); }

function setChain(id, chain) {
  db.prepare('UPDATE tasks SET chain = ? WHERE id = ?').run(chain ? JSON.stringify(chain) : null, id);
  return getTask(id);
}

// --- External dependency (flag / resolve) ---

const setExternalTxn = db.transaction((taskId, dep) => {
  db.prepare('DELETE FROM external_dependencies WHERE task_id = ?').run(taskId);
  insertExt.run({
    id: newId('e'),
    task_id: taskId,
    person_id: dep.personId || null,
    note: dep.note || null,
    flagged_at: dep.flaggedAt || null,
    notified_at: dep.notifiedAt || null,
    resolved_at: dep.resolvedAt || null
  });
});
function setExternalDependency(taskId, dep) { setExternalTxn(taskId, dep); return getTask(taskId); }

function markNotified(taskId, when) {
  db.prepare('UPDATE external_dependencies SET notified_at = ? WHERE task_id = ?').run(when, taskId);
}
function resolveExternalDependency(taskId, when) {
  const row = extStmt.get(taskId);
  if (!row) return null;
  db.prepare('UPDATE external_dependencies SET resolved_at = ? WHERE id = ?').run(when, row.id);
  return getTask(taskId);
}

// --- People ---

function getPeople() {
  return db.prepare('SELECT * FROM people').all().map(p => ({
    id: p.id, name: p.name, email: p.email,
    isAppUser: !!p.is_app_user, linkedUserId: p.linked_user_id
  }));
}
function getPerson(id) {
  const p = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
  return p ? { id: p.id, name: p.name, email: p.email, isAppUser: !!p.is_app_user, linkedUserId: p.linked_user_id } : null;
}
function addPerson({ name, email, isAppUser, linkedUserId }) {
  const person = {
    id: newId('p'), name: String(name).trim(), email: email ? String(email).trim() : null,
    is_app_user: isAppUser ? 1 : 0, linked_user_id: linkedUserId || null
  };
  db.prepare('INSERT INTO people (id, name, email, is_app_user, linked_user_id) VALUES (@id, @name, @email, @is_app_user, @linked_user_id)').run(person);
  return getPerson(person.id);
}
function deletePerson(id) {
  return db.prepare('DELETE FROM people WHERE id = ?').run(id).changes;
}
function linkPersonToUser(personId, userId) {
  db.prepare('UPDATE people SET is_app_user = 1, linked_user_id = ? WHERE id = ?').run(userId, personId);
}

// --- Users ---

function getUsers() {
  return db.prepare('SELECT * FROM users ORDER BY name').all()
    .map(u => ({ id: u.id, name: u.name, email: u.email, createdAt: u.created_at }));
}
function getUser(id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return u ? { id: u.id, name: u.name, email: u.email, createdAt: u.created_at } : null;
}
function addUser({ name, email }) {
  const user = { id: newId('u'), name: String(name).trim(), email: email ? String(email).trim() : null, created_at: new Date().toISOString() };
  db.prepare('INSERT INTO users (id, name, email, created_at) VALUES (@id, @name, @email, @created_at)').run(user);
  return getUser(user.id);
}

// --- Bridge colleagues <-> app users by matching email ---

function syncPersonUserLinks() {
  const users = db.prepare("SELECT id, email FROM users WHERE email IS NOT NULL AND email != ''").all();
  const byEmail = new Map(users.map(u => [u.email.toLowerCase(), u.id]));
  const people = db.prepare('SELECT id, email FROM people').all();
  const link = db.prepare('UPDATE people SET is_app_user = 1, linked_user_id = ? WHERE id = ?');
  const unlink = db.prepare('UPDATE people SET is_app_user = 0, linked_user_id = NULL WHERE id = ?');
  const tx = db.transaction(() => {
    for (const p of people) {
      const uid = p.email ? byEmail.get(p.email.toLowerCase()) : null;
      if (uid) link.run(uid, p.id);
      else unlink.run(p.id);
    }
  });
  tx();
}

// Unresolved dependencies flagged on a person linked to this user (their "waiting on you").
function getWaitingOnUser(userId) {
  return db.prepare(`
    SELECT ed.task_id AS taskId, ed.note AS note, ed.flagged_at AS flaggedAt,
           ed.notified_at AS notifiedAt, t.title AS taskTitle, p.name AS personName
    FROM external_dependencies ed
    JOIN people p ON p.id = ed.person_id
    JOIN tasks  t ON t.id = ed.task_id
    WHERE p.linked_user_id = ? AND ed.resolved_at IS NULL
    ORDER BY ed.flagged_at DESC
  `).all(userId);
}

module.exports = {
  db, newId,
  getTasks, getTask, replaceAllTasks,
  createTask, updateTask, deleteTask, setChain,
  setExternalDependency, markNotified, resolveExternalDependency,
  getPeople, getPerson, addPerson, deletePerson, linkPersonToUser,
  getUsers, getUser, addUser,
  syncPersonUserLinks, getWaitingOnUser
};
