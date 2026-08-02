const { Pool } = require('pg');

// Render gives two connection strings: an INTERNAL one (host like `dpg-xxxx-a`,
// no domain — only resolves inside Render's network, no SSL needed) and an
// EXTERNAL one (host ends in `.render.com`, requires SSL). Detect which we have.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set — point it at your Postgres database.');
}
const useSSL = /render\.com/.test(connectionString) || process.env.PGSSL === 'require';
const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

// --- Schema (normalized; ported from the previous SQLite shape) ---
// Timestamps are kept as TEXT ISO strings (not TIMESTAMPTZ) so the report
// code and frontend keep receiving the exact string shape they already expect.
const SCHEMA = `
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
    is_app_user    BOOLEAN NOT NULL DEFAULT FALSE,
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
`;

async function init() {
  await pool.query(SCHEMA);
}

function newId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 10);
}

// Run a set of queries inside a transaction, giving the callback a dedicated client.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Assemble a task row into the object shape the frontend expects ---

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

function hydrateWith(row, deps, external) {
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
    dependsOn: deps || [],
    externalDependency: external || null,
    chain: row.chain ? JSON.parse(row.chain) : null
  };
}

async function hydrate(row, client = pool) {
  if (!row) return null;
  const deps = await client.query('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1', [row.id]);
  const ext = await client.query('SELECT * FROM external_dependencies WHERE task_id = $1 ORDER BY flagged_at DESC LIMIT 1', [row.id]);
  return hydrateWith(row, deps.rows.map(r => r.depends_on_task_id), mapExternal(ext.rows[0]));
}

async function getTasks() {
  const { rows } = await pool.query('SELECT * FROM tasks');
  if (!rows.length) return [];
  // Bulk-load deps and latest external dependency to avoid an N+1 per task.
  const depsRes = await pool.query('SELECT task_id, depends_on_task_id FROM task_dependencies');
  const extRes = await pool.query(
    'SELECT DISTINCT ON (task_id) * FROM external_dependencies ORDER BY task_id, flagged_at DESC'
  );
  const depMap = {};
  for (const r of depsRes.rows) (depMap[r.task_id] = depMap[r.task_id] || []).push(r.depends_on_task_id);
  const extMap = {};
  for (const r of extRes.rows) extMap[r.task_id] = mapExternal(r);
  return rows.map(r => hydrateWith(r, depMap[r.id] || [], extMap[r.id] || null));
}

async function getTask(id) {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  return hydrate(rows[0]);
}

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

async function insertTaskRow(client, row) {
  await client.query(
    `INSERT INTO tasks (id, title, notes, status, priority, created_by, assigned_to, created_at, completed_at, chain)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [row.id, row.title, row.notes, row.status, row.priority, row.created_by, row.assigned_to, row.created_at, row.completed_at, row.chain]
  );
}

async function insertDep(client, taskId, depId) {
  await client.query(
    'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [taskId, depId]
  );
}

async function insertExternal(client, e) {
  await client.query(
    `INSERT INTO external_dependencies (id, task_id, person_id, note, flagged_at, notified_at, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.id, e.task_id, e.person_id, e.note, e.flagged_at, e.notified_at, e.resolved_at]
  );
}

// --- Bulk replace (preserves the old PUT contract; used by migrate.js) ---

async function replaceAllTasks(tasks) {
  return withTx(async (client) => {
    await client.query('DELETE FROM external_dependencies');
    await client.query('DELETE FROM task_dependencies');
    await client.query('DELETE FROM tasks');
    for (const t of tasks) {
      const row = taskToRow(t);
      await insertTaskRow(client, row);
      for (const depId of (t.dependsOn || [])) await insertDep(client, row.id, depId);
      if (t.externalDependency) {
        const e = t.externalDependency;
        await insertExternal(client, {
          id: newId('e'), task_id: row.id, person_id: e.personId || null, note: e.note || null,
          flagged_at: e.flaggedAt || null, notified_at: e.notifiedAt || null, resolved_at: e.resolvedAt || null
        });
      }
    }
  });
}

// --- Granular task writes ---

async function createTask(t) {
  const row = taskToRow(t);
  await withTx(async (client) => {
    await insertTaskRow(client, row);
    for (const depId of (t.dependsOn || [])) await insertDep(client, row.id, depId);
  });
  return getTask(row.id);
}

async function updateTask(id, fields) {
  const existingRes = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  const existing = existingRes.rows[0];
  if (!existing) return null;
  const merged = {
    title: fields.title !== undefined ? fields.title : existing.title,
    notes: fields.notes !== undefined ? (fields.notes || null) : existing.notes,
    status: fields.status !== undefined ? fields.status : existing.status,
    priority: fields.priority !== undefined ? fields.priority : existing.priority,
    assigned_to: fields.assignedTo !== undefined ? (fields.assignedTo || null) : existing.assigned_to,
    completed_at: fields.completedAt !== undefined ? fields.completedAt : existing.completed_at
  };
  await withTx(async (client) => {
    await client.query(
      `UPDATE tasks SET title=$1, notes=$2, status=$3, priority=$4, assigned_to=$5, completed_at=$6 WHERE id=$7`,
      [merged.title, merged.notes, merged.status, merged.priority, merged.assigned_to, merged.completed_at, id]
    );
    if (fields.dependsOn !== undefined) {
      await client.query('DELETE FROM task_dependencies WHERE task_id = $1', [id]);
      for (const depId of fields.dependsOn) await insertDep(client, id, depId);
    }
  });
  return getTask(id);
}

async function deleteTask(id) {
  await withTx(async (client) => {
    await client.query('DELETE FROM external_dependencies WHERE task_id = $1', [id]);
    await client.query('DELETE FROM task_dependencies WHERE task_id = $1 OR depends_on_task_id = $1', [id]);
    await client.query('DELETE FROM tasks WHERE id = $1', [id]);
  });
}

async function setChain(id, chain) {
  await pool.query('UPDATE tasks SET chain = $1 WHERE id = $2', [chain ? JSON.stringify(chain) : null, id]);
  return getTask(id);
}

// --- External dependency (flag / resolve) ---

async function setExternalDependency(taskId, dep) {
  await withTx(async (client) => {
    await client.query('DELETE FROM external_dependencies WHERE task_id = $1', [taskId]);
    await insertExternal(client, {
      id: newId('e'), task_id: taskId, person_id: dep.personId || null, note: dep.note || null,
      flagged_at: dep.flaggedAt || null, notified_at: dep.notifiedAt || null, resolved_at: dep.resolvedAt || null
    });
  });
  return getTask(taskId);
}

async function markNotified(taskId, when) {
  await pool.query('UPDATE external_dependencies SET notified_at = $1 WHERE task_id = $2', [when, taskId]);
}

async function resolveExternalDependency(taskId, when) {
  const { rows } = await pool.query(
    'SELECT * FROM external_dependencies WHERE task_id = $1 ORDER BY flagged_at DESC LIMIT 1', [taskId]
  );
  if (!rows[0]) return null;
  await pool.query('UPDATE external_dependencies SET resolved_at = $1 WHERE id = $2', [when, rows[0].id]);
  return getTask(taskId);
}

// --- People ---

function mapPerson(p) {
  return p ? { id: p.id, name: p.name, email: p.email, isAppUser: !!p.is_app_user, linkedUserId: p.linked_user_id } : null;
}

async function getPeople() {
  const { rows } = await pool.query('SELECT * FROM people');
  return rows.map(mapPerson);
}
async function getPerson(id) {
  const { rows } = await pool.query('SELECT * FROM people WHERE id = $1', [id]);
  return mapPerson(rows[0]);
}
async function addPerson({ name, email, isAppUser, linkedUserId }) {
  const id = newId('p');
  await pool.query(
    'INSERT INTO people (id, name, email, is_app_user, linked_user_id) VALUES ($1,$2,$3,$4,$5)',
    [id, String(name).trim(), email ? String(email).trim() : null, !!isAppUser, linkedUserId || null]
  );
  return getPerson(id);
}
async function deletePerson(id) {
  const res = await pool.query('DELETE FROM people WHERE id = $1', [id]);
  return res.rowCount;
}
async function linkPersonToUser(personId, userId) {
  await pool.query('UPDATE people SET is_app_user = TRUE, linked_user_id = $1 WHERE id = $2', [userId, personId]);
}

// --- Users ---

function mapUser(u) {
  return u ? { id: u.id, name: u.name, email: u.email, createdAt: u.created_at } : null;
}

async function getUsers() {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY name');
  return rows.map(mapUser);
}
async function getUser(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return mapUser(rows[0]);
}
async function getUserByEmail(email) {
  if (!email) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
  return mapUser(rows[0]);
}
async function addUser({ name, email }) {
  const id = newId('u');
  await pool.query(
    'INSERT INTO users (id, name, email, created_at) VALUES ($1,$2,$3,$4)',
    [id, String(name).trim(), email ? String(email).trim() : null, new Date().toISOString()]
  );
  return getUser(id);
}
async function deleteUser(id) {
  const res = await pool.query('DELETE FROM users WHERE id = $1', [id]);
  return res.rowCount;
}

// --- Bridge colleagues <-> app users by matching email ---

async function syncPersonUserLinks() {
  return withTx(async (client) => {
    const users = (await client.query("SELECT id, email FROM users WHERE email IS NOT NULL AND email != ''")).rows;
    const byEmail = new Map(users.map(u => [u.email.toLowerCase(), u.id]));
    const people = (await client.query('SELECT id, email FROM people')).rows;
    for (const p of people) {
      const uid = p.email ? byEmail.get(p.email.toLowerCase()) : null;
      if (uid) await client.query('UPDATE people SET is_app_user = TRUE, linked_user_id = $1 WHERE id = $2', [uid, p.id]);
      else await client.query('UPDATE people SET is_app_user = FALSE, linked_user_id = NULL WHERE id = $1', [p.id]);
    }
  });
}

// Unresolved dependencies flagged on a person linked to this user (their "waiting on you").
async function getWaitingOnUser(userId) {
  const { rows } = await pool.query(`
    SELECT ed.task_id AS "taskId", ed.note AS note, ed.flagged_at AS "flaggedAt",
           ed.notified_at AS "notifiedAt", t.title AS "taskTitle", p.name AS "personName"
    FROM external_dependencies ed
    JOIN people p ON p.id = ed.person_id
    JOIN tasks  t ON t.id = ed.task_id
    WHERE p.linked_user_id = $1 AND ed.resolved_at IS NULL
    ORDER BY ed.flagged_at DESC
  `, [userId]);
  return rows;
}

module.exports = {
  pool, init, newId,
  getTasks, getTask, replaceAllTasks,
  createTask, updateTask, deleteTask, setChain,
  setExternalDependency, markNotified, resolveExternalDependency,
  getPeople, getPerson, addPerson, deletePerson, linkPersonToUser,
  getUsers, getUser, getUserByEmail, addUser, deleteUser,
  syncPersonUserLinks, getWaitingOnUser
};
