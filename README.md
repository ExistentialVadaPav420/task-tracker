# Zephyr

A team task board with dependency tracking and auto-generated reports, built for tracking work discussed in manager check-ins.

## Run it

```
npm install
npm start
```

Then open http://localhost:3000

Tasks are saved to `data/tasks.json` on the server as you use the board — no database needed.

## Project structure

```
task-tracker/
  server.js          Express server + JSON file storage
  public/index.html  The board (frontend, single file)
  data/tasks.json     Created automatically on first save
```

## Put it on git

```
cd task-tracker
git init
git add .
git commit -m "Initial commit: task tracker"
```

Then create a repo on GitHub/GitLab and:

```
git remote add origin <your-repo-url>
git branch -M main
git push -u origin main
```

## Open in VS Code

```
code .
```

## Notes

- The daily report is generated live from whatever's marked done in `data/tasks.json` — it doesn't send itself anywhere on a schedule. Use the Copy or Download button in the UI when you're ready to share it.
- Dependencies between tasks are tracked by task ID; a task shows as "blocked" automatically if anything it depends on isn't done yet.
## Always use

lsof -ti:3000 | xargs kill -9 2>/dev/null; NODE_EXTRA_CA_CERTS=/Users/vibhav.shirke/Desktop/zscaler-root.pem npm start