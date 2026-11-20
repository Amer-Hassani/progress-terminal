# Changelog

## 0.1.3

- Finished agents fold into one line, so the running ones stay on screen when a task has many agents. Press a to list them, and a again to fold them.

## 0.1.2

- Percentages show three decimals and keep moving every second while Claude Code is working, instead of sitting still and then jumping. Numbers between Claude Code's own reports are estimates, marked with "~" and a lighter part in the bar.
- Estimates move only while work is really going on. When nothing is happening the numbers stop, and a new "now:" line says what is running, or "numbers paused", or "may be stuck" after 10 minutes without news.
- A big jump, like two steps finishing at once, is counted up smoothly instead of leaping. A reported number lower than the estimate never moves the display backwards.
- The step being worked on is marked, with how long it has been going, even when Claude Code has not reported a percentage yet.
- The time left is worked out from reported numbers only, and is hidden when a step was skipped or too little is known, so it no longer shows nonsense like hours for a short task.
- The view restarts by itself when its scripts are updated, and one damaged task file can no longer stop it.

## 0.1.1

- Running tasks are drawn first, before tasks waiting on background work, so the live task is never pushed off a small panel.
- After 10 seconds without scrolling, the view jumps back to the top.
- view.lock is now private to you (600), like the other files.

## 0.1.0

First release: the Progress terminal, Set up and Remove for Claude Code, history of finished tasks, downloads and long commands with speed and time left.
