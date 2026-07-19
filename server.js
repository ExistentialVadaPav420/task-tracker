require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const nodemailer = require('nodemailer');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel
} = require('docx');
const dbm = require('./db');
const auth = require('./auth');

let sgMail = null;
if (process.env.SENDGRID_API_KEY) {
  sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const app = express();
const PORT = process.env.PORT || 3000;

const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
function priorityOf(task) {
  return PRIORITY_LABELS[task.priority] ? task.priority : 'medium';
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET not set — using an insecure dev fallback. Set it in .env.');
}
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Auth gate: everything under /api requires a signed-in user, except the
// login/bootstrap endpoints below.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const open = ['/api/me', '/api/login', '/api/logout', '/api/users'];
  if (open.includes(req.path)) return next();
  if (!auth.getCurrentUser(req)) return res.status(401).json({ error: 'Not signed in' });
  next();
});

// --- Auth / users ---

app.get('/api/me', (req, res) => res.json({ user: auth.getCurrentUser(req) }));

app.get('/api/users', (req, res) => res.json(dbm.getUsers()));

app.post('/api/users', (req, res) => {
  const { name, email } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const user = dbm.addUser({ name, email });
  dbm.syncPersonUserLinks();
  res.status(201).json(user);
});

// Dependencies flagged on the signed-in user (they're the colleague being waited on).
app.get('/api/waiting-on-me', (req, res) => {
  const user = auth.getCurrentUser(req);
  res.json(dbm.getWaitingOnUser(user.id));
});

app.delete('/api/users/:id', (req, res) => {
  if (!auth.getCurrentUser(req)) return res.status(401).json({ error: 'Not signed in' });
  dbm.db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { userId } = req.body || {};
  const user = dbm.getUser(userId);
  if (!user) return res.status(400).json({ error: 'Unknown user' });
  auth.login(req, userId);
  res.json({ user });
});

app.post('/api/logout', async (req, res) => {
  await auth.logout(req);
  res.json({ ok: true });
});

// --- Tasks ---

app.get('/api/tasks', (req, res) => {
  res.json(dbm.getTasks());
});

// Granular writes (replaces the old bulk PUT, which lost concurrent edits).
app.post('/api/tasks', (req, res) => {
  const user = auth.getCurrentUser(req);
  const { title, notes, priority, dependsOn, assignedTo } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
  const task = dbm.createTask({
    title: String(title).trim(),
    notes: notes ? String(notes).trim() : '',
    priority: priority || 'medium',
    status: 'todo',
    dependsOn: Array.isArray(dependsOn) ? dependsOn : [],
    createdBy: user.id,
    assignedTo: assignedTo || user.id,
    createdAt: new Date().toISOString(),
    completedAt: null,
    chain: null
  });
  res.status(201).json({ task });
});

app.patch('/api/tasks/:id', (req, res) => {
  const existing = dbm.getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  const b = req.body || {};
  const fields = {};
  if (b.title !== undefined) fields.title = String(b.title).trim();
  if (b.notes !== undefined) fields.notes = b.notes ? String(b.notes).trim() : '';
  if (b.priority !== undefined) fields.priority = b.priority;
  if (b.dependsOn !== undefined) fields.dependsOn = Array.isArray(b.dependsOn) ? b.dependsOn : [];
  if (b.assignedTo !== undefined) fields.assignedTo = b.assignedTo || null;
  if (b.status !== undefined) {
    fields.status = b.status;
    fields.completedAt = b.status === 'done' ? new Date().toISOString() : null;
  }
  const task = dbm.updateTask(req.params.id, fields);
  res.json({ task });
});

app.delete('/api/tasks/:id', (req, res) => {
  dbm.deleteTask(req.params.id);
  res.json({ ok: true });
});

// --- Colleague directory ---

app.get('/api/people', (req, res) => {
  res.json(dbm.getPeople());
});

app.post('/api/people', (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  const person = dbm.addPerson({ name, email });
  dbm.syncPersonUserLinks();
  res.status(201).json(person);
});

app.delete('/api/people/:id', (req, res) => {
  const removed = dbm.deletePerson(req.params.id);
  res.json({ ok: true, removed });
});

// --- Colleague dependency flags + email ---

function makeTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  const port = Number(SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

async function sendDependencyEmail(person, task) {
  const fromName = process.env.FROM_NAME || 'Task Tracker';
  const fromEmail = process.env.FROM_EMAIL || process.env.SMTP_USER;
  const firstName = person.name.split(' ')[0];
  const dep = task.externalDependency;
  const flaggedDate = new Date(dep.flaggedAt).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });
  const text =
    `Hi ${firstName},\n\n` +
    `${fromName} flagged a task that's waiting on you:\n\n` +
    `  Task: ${task.title}\n` +
    `  Note: ${dep.note || '(no note)'}\n` +
    `  Flagged: ${flaggedDate}\n\n` +
    `Let them know when it's done, or reply to this email with any questions.\n`;
  const subject = `Dependency flagged: ${task.title}`;

  if (sgMail) {
    try {
      await sgMail.send({
        to: person.email,
        from: { email: fromEmail, name: fromName },
        replyTo: fromEmail,
        subject,
        text
      });
      return;
    } catch (e) {
      throw new Error(e.response?.body?.errors?.[0]?.message || e.message);
    }
  }

  const transport = makeTransport();
  if (!transport) {
    throw new Error('No email method configured — set SENDGRID_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS, in .env');
  }
  await transport.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to: person.email,
    replyTo: fromEmail,
    subject,
    text
  });
}

app.post('/api/tasks/:id/flag-dependency', async (req, res) => {
  const { personId, note } = req.body || {};
  const task = dbm.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const person = dbm.getPerson(personId);
  if (!person) return res.status(400).json({ error: 'Unknown colleague' });

  const now = new Date().toISOString();
  dbm.setExternalDependency(task.id, {
    personId,
    note: note ? String(note).trim() : '',
    flaggedAt: now,
    notifiedAt: null,
    resolvedAt: null
  });
  // Re-read so email uses the persisted dependency.
  let updated = dbm.getTask(task.id);

  let emailed = false;
  let emailError = null;
  try {
    await sendDependencyEmail(person, updated);
    dbm.markNotified(task.id, new Date().toISOString());
    emailed = true;
  } catch (err) {
    emailError = err.message;
    console.error('Dependency email failed', err);
  }

  res.json({ task: dbm.getTask(task.id), emailed, error: emailError });
});

app.post('/api/tasks/:id/resolve-dependency', (req, res) => {
  const task = dbm.getTask(req.params.id);
  if (!task || !task.externalDependency) {
    return res.status(404).json({ error: 'No dependency to resolve' });
  }
  const updated = dbm.resolveExternalDependency(req.params.id, new Date().toISOString());
  res.json({ task: updated });
});

// --- Dependency chain ---

const CHAIN_STATUSES = ['done', 'current', 'blocked', 'pending'];

function normalizeStage(s) {
  s = s || {};
  return {
    label: s.label ? String(s.label) : 'Stage',
    personId: s.personId || null,
    status: CHAIN_STATUSES.includes(s.status) ? s.status : 'pending',
    startedAt: s.startedAt || null,
    completedAt: s.completedAt || null,
    note: s.note ? String(s.note) : null
  };
}

app.post('/api/tasks/:id/chain', (req, res) => {
  const { chain } = req.body || {};
  if (!Array.isArray(chain) || !chain.length) {
    return res.status(400).json({ error: 'chain must be a non-empty array' });
  }
  const task = dbm.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const updated = dbm.setChain(task.id, chain.map(normalizeStage));
  res.json({ task: updated });
});

app.post('/api/tasks/:id/chain/advance', (req, res) => {
  const { note } = req.body || {};
  const task = dbm.getTask(req.params.id);
  if (!task || !Array.isArray(task.chain) || !task.chain.length) {
    return res.status(404).json({ error: 'Task has no chain' });
  }
  const chain = task.chain;
  const idx = chain.findIndex(s => s.status === 'current' || s.status === 'blocked');
  if (idx === -1) return res.status(400).json({ error: 'Chain has no active stage' });
  const now = new Date().toISOString();
  if (note) {
    chain[idx].status = 'blocked';
    chain[idx].note = String(note);
  } else {
    chain[idx].status = 'done';
    chain[idx].completedAt = now;
    chain[idx].note = null;
    if (idx + 1 < chain.length) {
      chain[idx + 1].status = 'current';
      chain[idx + 1].startedAt = now;
    }
  }
  const updated = dbm.setChain(task.id, chain);
  res.json({ task: updated });
});

app.post('/api/tasks/:id/chain/resolve-blocker', (req, res) => {
  const task = dbm.getTask(req.params.id);
  if (!task || !Array.isArray(task.chain)) {
    return res.status(404).json({ error: 'Task has no chain' });
  }
  const stage = task.chain.find(s => s.status === 'blocked');
  if (!stage) return res.status(400).json({ error: 'No blocked stage to resolve' });
  stage.status = 'current';
  stage.note = null;
  const updated = dbm.setChain(task.id, task.chain);
  res.json({ task: updated });
});

// --- Daily report (.docx) ---

function localDateStr(iso) {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtLongDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtShortDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function isBlocked(task, tasks) {
  return (task.dependsOn || []).some(id => {
    const dep = tasks.find(t => t.id === id);
    return dep && dep.status !== 'done';
  });
}

function blockers(task, tasks) {
  return (task.dependsOn || [])
    .map(id => tasks.find(t => t.id === id))
    .filter(t => t && t.status !== 'done');
}

function hasExternalBlock(task) {
  return !!(task.externalDependency && !task.externalDependency.resolvedAt);
}

function personName(personId, people) {
  const p = people.find(x => x.id === personId);
  return p ? p.name : 'a colleague';
}

function asSentence(note) {
  const s = String(note || '').trim();
  if (!s) return '';
  return /[.!?]$/.test(s) ? s : s + '.';
}

function reportPara(children) {
  return new Paragraph({ children, spacing: { after: 160 } });
}

function completedPara(task, tasks) {
  const runs = [
    new TextRun(`At ${fmtTime(task.completedAt)}, you completed `),
    new TextRun({ text: task.title, bold: true }),
    new TextRun('. ')
  ];
  const note = asSentence(task.notes);
  if (note) runs.push(new TextRun(note + ' '));
  const pr = priorityOf(task);
  if (pr === 'urgent' || pr === 'high') {
    runs.push(new TextRun(`This was flagged ${PRIORITY_LABELS[pr]}. `));
  }
  const dependents = tasks.filter(t => (t.dependsOn || []).includes(task.id));
  if (dependents.length) {
    runs.push(new TextRun(`This unblocks: ${dependents.map(d => d.title).join(', ')}.`));
  }
  return reportPara(runs);
}

function inProgressPara(task) {
  const runs = [
    new TextRun({ text: task.title, bold: true }),
    new TextRun(' is in progress. ')
  ];
  const note = asSentence(task.notes);
  if (note) runs.push(new TextRun(note + ' '));
  const pr = priorityOf(task);
  if (pr === 'urgent' || pr === 'high') {
    runs.push(new TextRun(`This is flagged ${PRIORITY_LABELS[pr]}.`));
  }
  return reportPara(runs);
}

function externalTail(task, people) {
  const dep = task.externalDependency;
  const status = dep.notifiedAt ? 'no response yet' : 'email not sent yet';
  return `flagged to ${personName(dep.personId, people)} on ${fmtShortDate(dep.flaggedAt)} — ${status}`;
}

function blockedPara(task, tasks, people) {
  const runs = [new TextRun({ text: task.title, bold: true })];
  const taskBlockers = blockers(task, tasks);
  if (taskBlockers.length) {
    runs.push(new TextRun(' is blocked, waiting on '));
    runs.push(new TextRun({ text: taskBlockers.map(b => b.title).join(', '), bold: true }));
    if (hasExternalBlock(task)) {
      runs.push(new TextRun(`, and ${externalTail(task, people)}.`));
    } else {
      runs.push(new TextRun('.'));
    }
  } else if (hasExternalBlock(task)) {
    runs.push(new TextRun(` is blocked, ${externalTail(task, people)}.`));
  } else {
    runs.push(new TextRun(' is blocked.'));
  }
  return reportPara(runs);
}

// Build the Completed / In progress / Blocked sections for a set of tasks.
function reportSections(tasks, allTasks, people, dateStr, headingLevel) {
  const completed = tasks
    .filter(t => t.completedAt && localDateStr(t.completedAt) === dateStr)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const blocked = tasks.filter(t => t.status !== 'done' && (isBlocked(t, allTasks) || hasExternalBlock(t)));
  const inProgress = tasks.filter(t => t.status === 'inprogress' && !isBlocked(t, allTasks) && !hasExternalBlock(t));

  const children = [];
  children.push(new Paragraph({ text: `Completed (${completed.length})`, heading: headingLevel }));
  if (completed.length) completed.forEach(t => children.push(completedPara(t, allTasks)));
  else children.push(reportPara([new TextRun('Nothing was marked done on this date.')]));

  children.push(new Paragraph({ text: `In progress (${inProgress.length})`, heading: headingLevel }));
  if (inProgress.length) inProgress.forEach(t => children.push(inProgressPara(t)));
  else children.push(reportPara([new TextRun('Nothing is in progress.')]));

  children.push(new Paragraph({ text: `Blocked (${blocked.length})`, heading: headingLevel }));
  if (blocked.length) blocked.forEach(t => children.push(blockedPara(t, allTasks, people)));
  else children.push(reportPara([new TextRun('Nothing is blocked.')]));

  return { children, counts: { completed: completed.length, inProgress: inProgress.length, blocked: blocked.length } };
}

function sendDoc(res, children, filename) {
  const doc = new Document({ sections: [{ children }] });
  Packer.toBuffer(doc).then(buffer => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }).catch(err => {
    console.error('Report generation failed', err);
    res.status(500).json({ error: 'Failed to generate report' });
  });
}

app.get('/api/report/:date', (req, res) => {
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }
  const tasks = dbm.getTasks();
  const people = dbm.getPeople();
  const { children, counts } = reportSections(tasks, tasks, people, dateStr, HeadingLevel.HEADING_2);
  const summary = `${counts.completed} task${counts.completed === 1 ? '' : 's'} completed, ` +
    `${counts.inProgress} in progress, ${counts.blocked} blocked.`;
  const doc = [
    new Paragraph({ text: `Daily Report — ${fmtLongDate(dateStr)}`, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: summary })], spacing: { after: 240 } }),
    ...children
  ];
  sendDoc(res, doc, `daily-report-${dateStr}.docx`);
});

dbm.syncPersonUserLinks();
app.listen(PORT, () => {
  console.log(`Task tracker running at http://localhost:${PORT}`);
});
