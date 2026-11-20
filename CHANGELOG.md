# Changelog

## 0.1.5

- A foreground agent that is still running is no longer closed as "stopped" when another agent finishes. Agents missing from Claude Code's running list are closed only when the turn ends, or when they had been listed before.
- Messages to an agent: when the agent finishes, every row for it is ticked, and a message row is never labelled "stopped".
- npm test runs all four test files.
- The extension page explains the colours of a bar.
- Zooming in (a narrow terminal) no longer breaks the bars or stops scrolling: no line is wider than the screen, and step names shorten first.

## 0.1.4

- When an agent finishes, its own row is ticked. Before, the oldest open agent row was ticked, so with several agents the wrong rows turned green.
- Agents that stop without a report (stopped by hand, killed by a restart, failed) are closed instead of showing as running for two hours. The folded line counts them: "52 agents done (30 stopped without a report)".

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
