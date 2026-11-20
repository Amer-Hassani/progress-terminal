"""Claude Code hooks for Progress Terminal. Prints nothing except the one SessionStart line. Never blocks a tool.

SessionStart      tell Claude how to add steps (one line of context)
UserPromptSubmit  remember a short, masked title for the next job (first 60 characters)
PreToolUse        first tool call starts the job; every call adds one log line built from the tool's
                  description or file name, never from command text; Agent/SendMessage add an agent step;
                  the call is recorded as running ('tool': name + start time) until its PostToolUse
PostToolUse       (and PostToolUseFailure) the running call ended; only used when these hooks are wired
SubagentStop      mark the oldest running agent step done
Stop              end the job, or keep it 'waiting' while a `progress run/dl` or an agent is still going

Only the main session counts: calls that carry agent_type (subagents) are skipped.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import core  # noqa: E402

NOT_A_PROMPT = ('[Subagent hand-back]', 'Another Claude session sent a message', '<agent-message',
                '<task-notification', '[SYSTEM NOTIFICATION')


def action(tool, ti):
    if tool == 'Bash':
        cmd = ti.get('command') or ''
        if 'progress-terminal/progress' in cmd or cmd.lstrip().startswith('progress '):
            return None
        return 'Bash: ' + (ti.get('description') or 'command')
    if tool in ('Edit', 'Write', 'Read', 'NotebookEdit'):
        return '%s: %s' % (tool, os.path.basename(ti.get('file_path') or ti.get('notebook_path') or ''))
    if tool == 'Agent':
        return 'Agent: ' + (ti.get('description') or 'agent')
    if tool == 'SendMessage':
        return 'Message to agent: ' + (ti.get('summary') or '')
    if tool.startswith('mcp__'):
        return 'Tool: ' + tool.split('__')[-1]
    return tool


def main():
    d = json.load(sys.stdin)
    ev = d.get('hook_event_name') or ''
    sid = d.get('session_id') or ''
    if ev == 'SessionStart':
        cmd = os.path.join(core.BASE, 'progress')
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext':
              'Progress Terminal is on: VS Code shows this session\'s work live. At the start of a task add its steps '
              'with `%s steps "step one|step two"`, then `%s set "step one" 40 "detail"` and `%s done "step one"`. '
              'Run long commands as `%s run "label" -- CMD` and downloads as `%s dl URL DEST`.' % ((cmd,) * 5)}}))
        return
    if not sid:
        return
    if ev == 'UserPromptSubmit':
        p = (d.get('prompt') or '').strip()
        if any(m in p[:400] for m in NOT_A_PROMPT):
            return
        first = next((l for l in p.splitlines() if l.strip() and not l.lstrip().startswith('<')), '')
        core.set_session_title(sid, core.short(first, 60) or 'Working')
        return
    if ev == 'SubagentStop':
        with core.Lock():
            j = core.live_job(sid)
            if j:
                agents_stopped(j, d)
                j['ev_t'] = time.time()
                if j.get('waiting') and not core.busy(j):
                    core.finish(j)
                core.save(j)
        return
    if d.get('agent_type'):
        return
    if ev == 'PreToolUse':
        tool = d.get('tool_name') or ''
        ti = d.get('tool_input') or {}
        line = action(tool, ti)
        with core.Lock():
            core.prune()
            j = core.current_job(sid) or core.new_job(sid, core.session_title(sid))
            j['waiting'] = False
            j['actions'] = j.get('actions', 0) + 1
            j['tool'] = {'name': core.short(line or tool, 60), 't': time.time()}
            j['ev_t'] = time.time()
            if line:
                core.add_log(j, line)
            if tool in ('Agent', 'SendMessage'):
                name = core.short(ti.get('description') or ti.get('summary') or 'agent', 40)
                a = {'name': name, 'done': False, 't0': time.time()}
                if tool == 'SendMessage' and ti.get('to'):
                    a['id'] = str(ti['to'])  # a message to an agent that already runs: its id is known now
                j.setdefault('agents', []).append(a)
            core.save(j)
        return
    if ev in ('PostToolUse', 'PostToolUseFailure'):
        with core.Lock():
            j = core.live_job(sid)
            if j:
                j['tool'] = None
                j['post'] = True  # this machine sends tool-finished events: idle time can be told apart
                j['ev_t'] = time.time()
                core.save(j)
        return
    if ev == 'Stop':
        with core.Lock():
            j = core.live_job(sid)
            if j:
                j['tool'] = None
                j['ev_t'] = time.time()
                agents_stopped(j, d)
                if core.busy(j):
                    j['waiting'] = True
                else:
                    core.finish(j)
                core.save(j)


GRACE = 30
DEAD = ('completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error')


def agents_stopped(j, d):
    """Close the agent rows whose agent is no longer running.
    SubagentStop names the agent that stopped (agent_id). SubagentStop and Stop also list what is still in
    flight (background_tasks): rows that match none of it were stopped, killed by a restart, or failed without a
    word, and are closed as 'stopped'. Rows younger than GRACE seconds are left alone (the agent may not be
    listed yet). Without that list (older Claude Code), the oldest open row is closed, as before."""
    now = time.time()
    rows = [a for a in j.get('agents', []) if not a.get('done')]
    tasks = d.get('background_tasks')
    listed = isinstance(tasks, list)
    gone = d.get('agent_id')
    running = [t for t in (tasks if listed else []) if isinstance(t, dict) and t.get('type', 'subagent') == 'subagent'
               and str(t.get('status', 'running')).lower() not in DEAD and t.get('id') != gone]
    alive = {t.get('id') for t in running}
    # learn ids: a running agent whose description matches an open row without an id
    for t in running:
        if not any(a.get('id') == t.get('id') for a in rows):
            row = next((a for a in rows if not a.get('id') and a['name'] == core.short(t.get('description') or 'agent', 40)), None)
            if row:
                row['id'] = t.get('id')
    if gone:
        row = next((a for a in rows if a.get('id') == gone), None)
        if not row:
            desc = next((t.get('description') for t in (tasks if listed else []) if isinstance(t, dict) and t.get('id') == gone), None)
            row = next((a for a in rows if not a.get('id') and desc and a['name'] == core.short(desc, 40)), None)
        if not row:  # a foreground agent (never listed) or an old Claude Code: the oldest open row without a live agent
            row = next((a for a in rows if not a.get('id') or a.get('id') not in alive), None)
        if row:
            row.update(done=True, t1=now, id=gone)
    if listed:
        for a in rows:
            if not a.get('done') and a.get('id') not in alive and now - a.get('t0', now) > GRACE:
                a.update(done=True, t1=now, stopped=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # never break a tool call; leave a trace
        try:
            with open(os.path.join(core.BASE, 'hook-errors.log'), 'a') as f:
                f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + repr(e)[:300] + '\n')
            os.chmod(os.path.join(core.BASE, 'hook-errors.log'), 0o600)
        except OSError:
            pass
