# Changelog

## 0.1.11

- You can see what each running agent is doing. Under its row: "now:" with its latest action and how long ago it started ("started 12s ago"), the action before it, how many tool calls it has made and how long it has been running. Only a short description or a file's name is shown, never the command itself or a full path.
- The tech lead's row is called "Tech lead", and its work shows the same way.
- A message to an agent no longer renames its row after the message: the row keeps the agent's own name, and the message is kept with it.

## 0.1.10

- Text from commands, watches, prompts and task names can no longer send control codes to your terminal. They are removed when the text is saved and again when it is shown, so task files from earlier versions are safe too. Earlier versions were affected.
- A watch started by an agent shows its time limit and latest line again.

## 0.1.9

- Background work started by an agent shows too: its commands and watches get rows in the BACKGROUND block, marked with the agent that started them.
- Agents started by another agent get their own row (↳) under the same task, and close when they finish or when the agent that started them finishes.
- Your own additions survive updates. Put them in `local/hook_local.py` inside the Progress Terminal folder: updates and uninstalling never touch that folder. The file is used only when it belongs to you and nobody else can change it, and a mistake in it is written to `hook-errors.log` instead of stopping anything.
- Before an update replaces a script that was changed by hand, the old copy is saved in `backups/` with the date and time.

## 0.1.8

- Work Claude Code starts in the background now shows. A long command it leaves running, and a watch it sets up to follow something (Monitor), each get a row in a new BACKGROUND block, with how long it has been running.
- When one ends, its row says how: done, failed (with the exit code), stopped, or time limit reached for a watch. A running watch also shows the latest line it reported, for example "copied 3 MB of ~139".
- A task stays open while its background work runs, and ends when the last of it ends.
- Finished background rows fold into one line, like finished agents. Press a to list them.
- Set up adds one more hook (after a Bash or Monitor call). If you already use Progress Terminal, the update adds it by itself and keeps a copy of your old settings.

## 0.1.7

- Arabic reads properly: letters are joined and each Arabic stretch reads right to left, with numbers inside it kept in order. Columns and bars stay where they were.
- Every agent row names its model and effort. A message to an agent started in an earlier prompt gets them from Claude Code's own record of that agent. With nothing set on the call or in the agent's file, the row shows the session's model and the effort from your settings, instead of "same model as session".

## 0.1.6

- Agents get their own block with a count: "AGENTS 2 running · 0 done", how many of each model and effort, and rows numbered A1, A2.
- Each agent row shows its model and effort (and its type, when it isn't general-purpose). They come from the Agent call, or from the agent's definition file in .claude/agents; otherwise the row says "same model as session · default effort".
- Tasks under one agent: `progress tasks "agent name" "task 1|task 2"` lists them under the agent and `progress task "agent name" "task 1"` ticks one. The agent's bar follows its finished tasks.
- A message to an agent that already has a row reuses that row (and reopens it if it had finished), so one agent is never shown as two.
- Long step and agent names are shortened in the middle, so their ends ("set A", "set B") stay readable.

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
