const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'tasks.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readTasks() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeTasks(tasks) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2));
}

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

app.listen(PORT, () => {
  console.log(`Task tracker running at http://localhost:${PORT}`);
});
