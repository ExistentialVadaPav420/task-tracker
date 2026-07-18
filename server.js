require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel
} = require('docx');


let sgMail = null;
if (process.env.SENDGRID_API_KEY) {
  sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const app = express();

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'tasks.json');
const PEOPLE_FILE = path.join(__dirname, 'data', 'people.json');

const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
function priorityOf(task) {
  return PRIORITY_LABELS[task.priority] ? task.priority : 'medium';
}
function priorityLabel(task) {
  return PRIORITY_LABELS[priorityOf(task)];
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [];
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const readTasks = () => readJson(DATA_FILE);
const writeTasks = (tasks) => writeJson(DATA_FILE, tasks);
const readPeople = () => readJson(PEOPLE_FILE);
const writePeople = (people) => writeJson(PEOPLE_FILE, people);

app.get('/api/tasks', (req, res) => {
  res.json(readTasks());
});

app.put('/api/tasks', (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected an array of tasks' });
  }
  writeTasks(req.body);
  res.json({ ok: true });
});

// --- Colleague directory ---

function newId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 10);
}

app.get('/api/people', (req, res) => {
  res.json(readPeople());
});

app.post('/api/people', (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  const people = readPeople();
  const person = { id: newId('p'), name: String(name).trim(), email: String(email).trim() };
  people.push(person);
  writePeople(people);
  res.status(201).json(person);
});

app.delete('/api/people/:id', (req, res) => {
  const people = readPeople();
  const next = people.filter(p => p.id !== req.params.id);
  writePeople(next);
  res.json({ ok: true, removed: people.length - next.length });
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
  const tasks = readTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const person = readPeople().find(p => p.id === personId);
  if (!person) return res.status(400).json({ error: 'Unknown colleague' });

  const now = new Date().toISOString();
  task.externalDependency = {
    personId,
    note: note ? String(note).trim() : '',
    flaggedAt: now,
    notifiedAt: null,
    resolvedAt: null
  };

  let emailed = false;
  let emailError = null;
  try {
    await sendDependencyEmail(person, task);
    task.externalDependency.notifiedAt = new Date().toISOString();
    emailed = true;
  } catch (err) {
    emailError = err.message;
    console.error('Dependency email failed', err);
  }

  writeTasks(tasks);
  res.json({ task, emailed, error: emailError });
});

app.post('/api/tasks/:id/resolve-dependency', (req, res) => {
  const tasks = readTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task || !task.externalDependency) {
    return res.status(404).json({ error: 'No dependency to resolve' });
  }
  task.externalDependency.resolvedAt = new Date().toISOString();
  writeTasks(tasks);
  res.json({ task });
});

// --- Daily report (.docx) ---

function localDateStr(iso) {
  // Match a completedAt timestamp to a YYYY-MM-DD local date.
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

// Turn a free-form note into a standalone sentence.
function asSentence(note) {
  const s = String(note || '').trim();
  if (!s) return '';
  return /[.!?]$/.test(s) ? s : s + '.';
}

// A normal (non-bulleted) report paragraph with spacing after it.
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

app.get('/api/report/:date', (req, res) => {
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  }
  const tasks = readTasks();
  const people = readPeople();

  const completed = tasks
    .filter(t => t.completedAt && localDateStr(t.completedAt) === dateStr)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const blocked = tasks.filter(t => t.status !== 'done' && (isBlocked(t, tasks) || hasExternalBlock(t)));
  const inProgress = tasks.filter(t => t.status === 'inprogress' && !isBlocked(t, tasks) && !hasExternalBlock(t));

  const summary = `${completed.length} task${completed.length === 1 ? '' : 's'} completed, ` +
    `${inProgress.length} in progress, ${blocked.length} blocked.`;

  const children = [
    new Paragraph({ text: `Daily Report — ${fmtLongDate(dateStr)}`, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: summary })], spacing: { after: 240 } }),
    new Paragraph({ text: `Completed (${completed.length})`, heading: HeadingLevel.HEADING_2 })
  ];

  if (completed.length) {
    completed.forEach(t => children.push(completedPara(t, tasks)));
  } else {
    children.push(reportPara([new TextRun('Nothing was marked done on this date.')]));
  }

  children.push(new Paragraph({ text: `In progress (${inProgress.length})`, heading: HeadingLevel.HEADING_2 }));
  if (inProgress.length) {
    inProgress.forEach(t => children.push(inProgressPara(t)));
  } else {
    children.push(reportPara([new TextRun('Nothing is in progress.')]));
  }

  children.push(new Paragraph({ text: `Blocked (${blocked.length})`, heading: HeadingLevel.HEADING_2 }));
  if (blocked.length) {
    blocked.forEach(t => children.push(blockedPara(t, tasks, people)));
  } else {
    children.push(reportPara([new TextRun('Nothing is blocked.')]));
  }

  const doc = new Document({ sections: [{ children }] });

  Packer.toBuffer(doc).then(buffer => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="daily-report-${dateStr}.docx"`);
    res.send(buffer);
  }).catch(err => {
    console.error('Report generation failed', err);
    res.status(500).json({ error: 'Failed to generate report' });
  });
});

app.listen(PORT, () => {
  console.log(`Task tracker running at http://localhost:${PORT}`);
});
