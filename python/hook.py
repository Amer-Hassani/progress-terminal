"""Claude Code hooks for Progress Terminal. Prints nothing except the one SessionStart line. Never blocks a tool.

SessionStart      tell Claude how to add steps (one line of context)
UserPromptSubmit  remember a short, masked title for the next job (first 60 characters)
PreToolUse        first tool call starts the job; every call adds one log line built from the tool's
                  description or file name, never from command text; Agent/SendMessage add an agent step;
                  the call is recorded as running ('tool': name + start time) until its PostToolUse
PostToolUse       (Bash and Monitor) the call ended; a background command or watch learns its task id here
SubagentStop      mark the oldest running agent step done
Stop              end the job, or keep it 'waiting' while a `progress run/dl`, an agent or a background job is going

Background jobs (Bash with run_in_background, Monitor) get a row each in job['bg']: PreToolUse adds it,
PostToolUse gives it its task id, and core.bg_refresh settles it from Claude Code's output file for that task.
Stop/SubagentStop (background_tasks) and task notifications (UserPromptSubmit) fill in what the file can't tell.

Only the main session's calls count, with one exception: an Agent launched by an agent adds a nested row (↳) under
the same job, closed by its own SubagentStop (matched through Claude Code's meta.json: parentAgentId + description)
or when its parent row closes. A background command or watch started by an agent gets a row too, tagged with the agent.

Your own additions live in local/hook_local.py next to this file. Updates never touch that folder. If the file exists,
belongs to you and nobody else can write to it, the hook loads it and calls its optional function

    on_event(event, data, job) -> str or None

for SessionStart and UserPromptSubmit (job is None) and for each PreToolUse of the main session (job is the task, inside
the store lock, saved afterwards, so it may keep its own fields in job['local']). A string it returns is passed to
Claude as extra context. Anything that goes wrong in it is written to hook-errors.log and never stops the hook.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import core  # noqa: E402

NOT_A_PROMPT = ('[Subagent hand-back]', 'Another Claude session sent a message', '<agent-message',
                '<task-notification', '[SYSTEM NOTIFICATION')


MODELS = {'sonnet': 'Sonnet', 'opus': 'Opus', 'haiku': 'Haiku', 'fable': 'Fable'}


def model_label(m):
    """'sonnet' -> 'Sonnet', 'claude-sonnet-5-5' -> 'Sonnet 5.5', 'inherit'/None -> None."""
    if not m or str(m).lower() in ('inherit', 'default'):
        return None
    m = str(m).strip()
    if m.lower() in MODELS:
        return MODELS[m.lower()]
    r = re.match(r'(?:claude-)?([a-z]+)-(\d+)(?:-(\d+))?', m.lower())
    if r and r.group(1) in MODELS:
        return MODELS[r.group(1)] + ' ' + r.group(2) + ('.' + r.group(3) if r.group(3) else '')
    return m[:24]


def definition(typ, cwd):
    """model and effort from the agent's definition file (.claude/agents/<type>.md), project first."""
    out = {}
    for base in ([os.path.join(cwd, '.claude', 'agents')] if cwd else []) + [os.path.join(config_dir(), 'agents')]:
        f = os.path.join(base, typ + '.md')
        try:
            text = open(f, encoding='utf-8').read(4000)
        except OSError:
            continue
        fm = text.split('---')[1] if text.startswith('---') else ''
        for key in ('model', 'effort'):
            r = re.search(r'^%s:\s*["\']?([^"\'\n]+)' % key, fm, re.M)
            if r:
                out[key] = r.group(1).strip()
        break
    return out


def config_dir():
    return os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')


def settings_effort(model_id):
    """The effort Claude Code uses when nothing else sets one: per model in settings.json, then the general one."""
    try:
        st = json.load(open(os.path.join(config_dir(), 'settings.json'), encoding='utf-8'))
    except (OSError, ValueError):
        return None
    per = (st.get('modelSettings') or {}).get(str(model_id or '')) or {}
    return effort_label(per.get('effortLevel')) or effort_label(st.get('effortLevel'))


def last_model_id(path):
    """The model id a transcript last answered with ('claude-fable-5-2'), from its tail; None if unknown."""
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 300000))
            tail = f.read().decode('utf-8', 'ignore')
    except (OSError, TypeError):
        return None
    found = re.findall(r'"model"\s*:\s*"(claude-[a-z0-9-]+)"', tail)
    return found[-1] if found else None


def last_model(path):
    return model_label(last_model_id(path))


def effort_label(e):
    if isinstance(e, dict):
        e = e.get('level') or e.get('effort')
    return str(e) if e and isinstance(e, (str, int)) else None


def agent_spec(ti, cwd, hook=None):
    """What the user should see about an agent: its model, effort and type. With nothing set on the call or in the
    agent's file, the agent runs on the session's model and effort, so those are shown by name."""
    hook = hook or {}
    typ = str(ti.get('subagent_type') or 'general-purpose')
    d = definition(typ, cwd) if typ != 'fork' else {}
    mid = next((m for m in (ti.get('model'), d.get('model')) if model_label(m)), None) \
        or last_model_id(hook.get('transcript_path'))
    model = model_label(mid)
    effort = effort_label(ti.get('effort')) or effort_label(d.get('effort')) or effort_label(hook.get('effort')) \
        or settings_effort(mid)
    return {'type': typ, 'model': model or 'same model as session', 'effort': effort or 'default effort'}


def spec_by_id(aid, hook):
    """An agent launched earlier (another prompt, or before model and effort were recorded): its type from
    Claude Code's own record of it, the model it really answered with, the effort from its file."""
    tp = hook.get('transcript_path') or ''
    if not aid or not tp.endswith('.jsonl') or not re.match(r'^[A-Za-z0-9_-]+$', aid):
        return {}
    base = os.path.join(tp[:-6], 'subagents', 'agent-' + aid)
    try:
        meta = json.load(open(base + '.meta.json', encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    out = agent_spec({'subagent_type': meta.get('agentType')}, hook.get('cwd') or '', hook)
    real = last_model(base + '.jsonl')
    if real:
        out['model'] = real
    return out


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


def main(d):
    ev = d.get('hook_event_name') or ''
    sid = d.get('session_id') or ''
    if ev == 'SessionStart':
        cmd = os.path.join(core.BASE, 'progress')
        CONTEXT.append('Progress Terminal is on: VS Code shows this session\'s work live. At the start of a task add its steps '
                       'with `%s steps "step one|step two"`, then `%s set "step one" 40 "detail"` and `%s done "step one"`. '
                       'Run long commands as `%s run "label" -- CMD` and downloads as `%s dl URL DEST`.' % ((cmd,) * 5))
        local_event(ev, d, None)
        return
    if not sid:
        return
    if ev == 'UserPromptSubmit':
        p = (d.get('prompt') or '').strip()
        if '<task-notification' in p:
            bg_notified(sid, p)
        if any(m in p[:400] for m in NOT_A_PROMPT):
            return
        first = next((l for l in p.splitlines() if l.strip() and not l.lstrip().startswith('<')), '')
        core.set_session_title(sid, core.short(first, 60) or 'Working')
        local_event(ev, d, None)
        return
    if ev == 'SubagentStop':
        with core.Lock():
            j = core.live_job(sid)
            if j:
                if not nested_stopped(j, d):
                    agents_stopped(j, d, ev)
                close_orphans(j)
                bg_stopped(j, d, ev)
                j['ev_t'] = time.time()
                if j.get('waiting') and not core.busy(j):
                    core.finish(j)
                core.save(j)
        return
    if d.get('agent_type'):
        # inside an agent: only its own Agent launches count, shown as nested rows (↳) under the main job
        if ev == 'PreToolUse' and d.get('tool_name') == 'Agent':
            ti = d.get('tool_input') or {}
            with core.Lock():
                j = core.current_job(sid) or core.live_job(sid)
                if j:
                    a = {'name': '↳ ' + core.short(ti.get('description') or 'agent', 38), 'done': False,
                         't0': time.time(), 'nested': True, 'parent': str(d.get('agent_id') or ''),
                         'desc': core.short(ti.get('description') or 'agent', 40)}
                    a.update(agent_spec(ti, d.get('cwd') or '', {}))
                    j.setdefault('agents', []).append(a)
                    j['ev_t'] = time.time()
                    core.save(j)
        # ... and its background commands and watches: a row each, tagged with the agent
        tool = d.get('tool_name') or ''
        ti = d.get('tool_input') or {}
        if ev == 'PreToolUse' and (tool == 'Monitor' or (tool == 'Bash' and ti.get('run_in_background') and action(tool, ti))):
            with core.Lock():
                j = core.current_job(sid) or core.live_job(sid)
                if j:
                    r = bg_started(j, tool, ti, d)
                    r['agent'] = str(d.get('agent_id') or '')
                    r['agent_type'] = str(d.get('agent_type') or '')
                    core.save(j)
        elif ev in ('PostToolUse', 'PostToolUseFailure') and tool in BG_TOOLS:
            with core.Lock():
                j = core.live_job(sid)
                if j and any(r.get('tuid') == str(d.get('tool_use_id') or '') for r in j.get('bg', [])):
                    bg_launched(j, d, ev)  # never touches the main session's running-tool state
                    core.save(j)
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
            if tool == 'Monitor' or (tool == 'Bash' and ti.get('run_in_background') and line):
                bg_started(j, tool, ti, d)
            to = str(ti.get('to') or '') if tool == 'SendMessage' else ''
            known = next((b for b in reversed(j.get('agents', [])) if to and not b.get('msg') and
                          (b.get('id') == to or b.get('name') == to)), None) if to else None
            if known:
                # a message to an agent that already has a row: same agent, so the same row (reopened if it had
                # finished), never a second row that makes one agent look like two
                if known.get('done'):
                    known['done'] = False
                    known.pop('stopped', None)
                    known['t0'] = time.time()
                known.setdefault('msgs', []).append(core.short(ti.get('summary') or 'message', 40))
            elif tool in ('Agent', 'SendMessage'):
                name = core.short(ti.get('description') or ti.get('summary') or 'agent', 40)
                a = {'name': name, 'done': False, 't0': time.time()}
                if tool == 'SendMessage' and ti.get('to'):
                    a['id'] = str(ti['to'])  # a message to an agent that already runs: its id (or name) is known now
                    a['msg'] = True
                    prev = next((b for b in reversed(j.get('agents', [])) if b.get('model') and
                                 (b.get('id') == a['id'] or b.get('name') == a['id'])), None)
                    if not prev:  # launched in an earlier prompt: look in this session's other jobs
                        prev = next((b for o in reversed(core.all_jobs()) if o.get('sid') == sid
                                     for b in reversed(o.get('agents', [])) if b.get('model') and
                                     (b.get('id') == a['id'] or b.get('name') == a['id'])), None)
                    a.update({k: prev[k] for k in ('type', 'model', 'effort') if k in prev} if prev
                             else spec_by_id(a['id'], d))
                else:
                    a.update(agent_spec(ti, d.get('cwd') or '', d))
                j.setdefault('agents', []).append(a)
            local_event(ev, d, j)
            core.save(j)
        return
    if ev in ('PostToolUse', 'PostToolUseFailure'):
        tool = d.get('tool_name') or ''
        with core.Lock():
            j = core.live_job(sid)
            if j:
                j['tool'] = None
                if tool not in BG_TOOLS:
                    # this machine sends tool-finished events for every tool: idle time can be told apart
                    # (setup wires PostToolUse for Bash and Monitor only, which says nothing about the others)
                    j['post'] = True
                j['ev_t'] = time.time()
                if tool in BG_TOOLS:
                    bg_launched(j, d, ev)
                core.save(j)
        return
    if ev == 'Stop':
        with core.Lock():
            j = core.live_job(sid)
            if j:
                j['tool'] = None
                j['ev_t'] = time.time()
                agents_stopped(j, d, ev)
                close_orphans(j)
                bg_stopped(j, d, ev)
                if core.busy(j):
                    j['waiting'] = True
                else:
                    core.finish(j)
                core.save(j)


def agent_meta(aid, d):
    """Claude Code's own record of an agent (description, parentAgentId, spawnDepth), or {}."""
    if not aid or not re.match(r'^[A-Za-z0-9_-]+$', str(aid)):
        return {}
    paths = []
    atp = d.get('agent_transcript_path') or ''
    if atp.endswith('.jsonl'):
        paths.append(atp[:-6] + '.meta.json')
    tp = d.get('transcript_path') or ''
    if tp.endswith('.jsonl'):
        paths.append(os.path.join(tp[:-6], 'subagents', 'agent-%s.meta.json' % aid))
    for p in paths:
        try:
            return json.load(open(p, encoding='utf-8'))
        except (OSError, ValueError):
            continue
    return {}


def nested_stopped(j, d):
    """SubagentStop of an agent launched by another agent: close its ↳ row. True when it was such an agent."""
    gone = d.get('agent_id')
    meta = agent_meta(gone, d)
    parent = meta.get('parentAgentId')
    if not parent:
        return False
    open_rows = [a for a in j.get('agents', []) if a.get('nested') and not a.get('done')]
    hit = next((a for a in open_rows if a.get('id') == gone), None) \
        or next((a for a in open_rows if not a.get('id') and a.get('parent') == parent and
                 a.get('desc') == core.short(meta.get('description') or 'agent', 40)), None) \
        or next((a for a in open_rows if not a.get('id') and a.get('parent') == parent), None)
    if hit:
        hit.update(done=True, t1=time.time(), id=gone)
    return True


def close_orphans(j):
    """A nested row whose parent agent has finished is finished too."""
    done_ids = {a.get('id') for a in j.get('agents', []) if a.get('done') and a.get('id')}
    for a in j.get('agents', []):
        if a.get('nested') and not a.get('done') and a.get('parent') in done_ids:
            a.update(done=True, t1=time.time())


BG_TOOLS = ('Bash', 'Monitor')


def bg_started(j, tool, ti, d):
    """A background command or watch was asked for: one row, open until its output file says it ended."""
    watch = tool == 'Monitor'
    r = {'kind': 'watch' if watch else 'command', 't0': time.time(),
         'name': core.short(ti.get('description') or ('watch' if watch else 'command'), 60),
         'tuid': str(d.get('tool_use_id') or ''), 'slug': os.path.basename(os.path.dirname(d.get('transcript_path') or ''))}
    if watch:
        try:
            r['timeout'] = min(int(ti.get('timeout_ms') or 300000), 1800000)
        except (TypeError, ValueError):
            r['timeout'] = 300000
    j.setdefault('bg', []).append(r)
    return r


def bg_launched(j, d, ev):
    """PostToolUse of a background command or watch: its task id (and the real time limit of a watch)."""
    rows = [r for r in j.get('bg', []) if not r.get('state')]
    tuid = str(d.get('tool_use_id') or '')
    r = next((x for x in rows if tuid and x.get('tuid') == tuid), None)
    if not r:
        return
    if ev == 'PostToolUseFailure':
        core.bg_close(r, 'failed')
        return
    resp = d.get('tool_response')
    tid = None
    if isinstance(resp, dict):
        tid = resp.get('backgroundTaskId') or resp.get('taskId')
        if resp.get('timeoutMs'):
            try:
                r['timeout'] = int(resp['timeoutMs'])
            except (TypeError, ValueError):
                pass
        if resp.get('persistent'):
            r.pop('timeout', None)
    elif isinstance(resp, str):
        m = re.search(r'(?:with ID:|task) ([A-Za-z0-9_-]+)', resp)
        tid = m.group(1) if m else None
    if not tid:
        if d.get('tool_name') == 'Bash':  # it did not go to the background after all (or failed to start)
            j['bg'].remove(r)
        return
    r['id'] = str(tid)
    core.bg_refresh(j)


def bg_stopped(j, d, ev):
    """Stop/SubagentStop list the background work still in flight: rows learn their ids from it, and on Stop an open
    row whose task is no longer listed and whose output file can't be found is closed as ended."""
    tasks = d.get('background_tasks')
    rows = [r for r in j.get('bg', []) if not r.get('state')]
    if not rows:
        return
    listed = isinstance(tasks, list)
    live = [t for t in (tasks if listed else []) if isinstance(t, dict) and t.get('type') != 'subagent']
    for t in live:
        if any(r.get('id') == t.get('id') for r in rows):
            continue
        r = next((x for x in rows if not x.get('id') and x['name'] == core.short(t.get('description') or '', 60)), None)
        if r and t.get('id') and core._ID.match(str(t['id'])):
            r['id'] = str(t['id'])
    core.bg_refresh(j)
    if listed and ev == 'Stop':
        ids = {t.get('id') for t in live}
        now = time.time()
        for r in j.get('bg', []):
            if not r.get('state') and not r.get('out') and r.get('id') not in ids and now - r.get('t0', now) > GRACE:
                core.bg_close(r, 'ended', t1=now)


NOTE = re.compile(r'<task-notification>(.*?)</task-notification>', re.S)


def _tag(block, name):
    m = re.search(r'<%s>(.*?)</%s>' % (name, name), block, re.S)
    return m.group(1).strip() if m else ''


def bg_notified(sid, prompt):
    """Claude Code's own notices about background work (they arrive as a prompt while the session is idle):
    a watch's latest event, and how a command or watch ended when its output file can't tell."""
    notes = [(_tag(b, 'task-id'), _tag(b, 'status'), _tag(b, 'summary'), _tag(b, 'event')) for b in NOTE.findall(prompt)]
    notes = [n for n in notes if n[0]]
    if not notes:
        return
    with core.Lock():
        for j in reversed(core.all_jobs()):
            if j.get('sid') != sid or not any(r.get('id') for r in j.get('bg', [])):
                continue
            dirty = False
            for tid, status, summary, event in notes:
                r = next((x for x in j['bg'] if x.get('id') == tid), None)
                if not r or r.get('state'):
                    continue
                dirty = True
                if event and r.get('kind') == 'watch' and not event.startswith('[Monitor'):
                    r['last'] = core.short(event.strip().splitlines()[-1], 200)
                core.bg_refresh(j)
                if r.get('state'):
                    continue
                code = re.search(r'exit(?: code)? (-?\d+)', summary)
                if event.startswith('[Monitor expired'):
                    core.bg_close(r, 'expired')
                elif status == 'completed':
                    core.bg_close(r, 'done', int(code.group(1)) if code else 0)
                elif status == 'failed':
                    core.bg_close(r, 'failed', int(code.group(1)) if code else None)
                elif status in ('killed', 'stopped', 'cancelled'):
                    core.bg_close(r, 'stopped')
            if dirty:
                if not j.get('end') and j.get('waiting') and not core.busy(j):
                    core.finish(j)
                core.save(j)


GRACE = 30
DEAD =('completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error')


def agents_stopped(j, d, ev):
    """Close the agent rows whose agent is no longer running.
    SubagentStop names the agent that stopped (agent_id): every row with that id is done. SubagentStop and Stop
    also list the background agents still in flight (background_tasks); foreground agents are never listed.
    - On Stop the turn is over, so no foreground agent can still run: any row not listed and older than GRACE
      is closed, as 'stopped' (no report came), except message rows, which are simply done.
    - On SubagentStop a foreground agent may still be running, so only rows whose id was seen in the list
      before can vanish.
    Without that list (older Claude Code), the oldest open row is closed, as before."""
    now = time.time()
    rows = [a for a in j.get('agents', []) if not a.get('done')]
    tasks = d.get('background_tasks')
    listed = isinstance(tasks, list)
    gone = d.get('agent_id')
    running = [t for t in (tasks if listed else []) if isinstance(t, dict) and t.get('type', 'subagent') == 'subagent'
               and str(t.get('status', 'running')).lower() not in DEAD and t.get('id') != gone]
    alive = {t.get('id') for t in running} | {t.get('name') for t in running if t.get('name')}
    # learn ids: a running agent whose description matches an open row without an id
    for t in running:
        if not any(a.get('id') == t.get('id') for a in rows):
            row = next((a for a in rows if not a.get('id') and a['name'] == core.short(t.get('description') or 'agent', 40)), None)
            if row:
                row.update(id=t.get('id'), seen=True)
        for a in rows:
            if a.get('id') == t.get('id'):
                a['seen'] = True
    rows = [a for a in rows if not a.get('nested')]  # nested rows are matched by nested_stopped, never guessed here
    if gone:
        hit = [a for a in rows if a.get('id') == gone]
        if not hit:
            desc = next((t.get('description') for t in (tasks if listed else []) if isinstance(t, dict) and t.get('id') == gone), None)
            hit = [a for a in rows if not a.get('id') and not a.get('msg') and desc and a['name'] == core.short(desc, 40)][:1]
        if not hit:  # a foreground agent (never listed), a nested one, or an old Claude Code: the oldest row with no id
            hit = [a for a in rows if not a.get('id') and not a.get('msg')][:1]
        for a in hit:
            a.update(done=True, t1=now, id=gone)
    if listed:
        for a in rows:
            if a.get('done') or a.get('id') in alive or now - a.get('t0', now) <= GRACE:
                continue
            if a.get('nested'):
                continue  # a nested agent never shows in the main list; it closes on its own stop or its parent's
            if ev == 'Stop':
                a.update(done=True, t1=now, stopped=not a.get('msg'))
            elif a.get('seen') and not a.get('msg'):
                a.update(done=True, t1=now, stopped=True)


CONTEXT = []  # extra context for Claude from this call: printed once, at the end
LOCAL = os.path.join(core.BASE, 'local', 'hook_local.py')
_local = []


def log_error(what):
    try:
        with open(os.path.join(core.BASE, 'hook-errors.log'), 'a') as f:
            f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + what[:300] + '\n')
        os.chmod(os.path.join(core.BASE, 'hook-errors.log'), 0o600)
    except OSError:
        pass


def _safe(path):
    """Yours, a plain file (no link), and nobody else can write to it or to its folder."""
    try:
        st = os.lstat(path)
        dt = os.stat(os.path.dirname(path))
    except OSError:
        return False
    import stat
    return stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o022 \
        and dt.st_uid == os.getuid() and not dt.st_mode & 0o022


def load_local():
    """local/hook_local.py, loaded by its exact path, once per call; None if missing, unsafe or broken."""
    if _local:
        return _local[0]
    mod = None
    if os.path.exists(LOCAL):
        if not _safe(LOCAL):
            log_error('hook_local: not loaded: %s must belong to you and be writable only by you (chmod 600, folder 700)' % LOCAL)
        else:
            try:
                import importlib.util
                spec = importlib.util.spec_from_file_location('hook_local', LOCAL)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
            except Exception as e:
                log_error('hook_local: load failed: ' + repr(e))
                mod = None
    _local.append(mod)
    return mod


def local_event(ev, d, job):
    mod = load_local()
    fn = getattr(mod, 'on_event', None) if mod else None
    if not callable(fn):
        return
    try:
        text = fn(ev, d, job)
        if isinstance(text, str) and text.strip():
            CONTEXT.append(text.strip())
    except Exception as e:
        log_error('hook_local: on_event(%s) failed: %r' % (ev, e))


if __name__ == '__main__':
    data = {}
    try:
        data = json.load(sys.stdin)
        main(data)
    except Exception as e:  # never break a tool call; leave a trace
        log_error(repr(e))
    if CONTEXT:
        print(json.dumps({'hookSpecificOutput': {'hookEventName': data.get('hook_event_name') or '',
                                                 'additionalContext': '\n\n'.join(CONTEXT)}}))
