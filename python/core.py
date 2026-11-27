"""Shared job store for Progress Terminal.

One JSON file per job in jobs/. The VS Code extension opens view.py when a new job appears.
Claude Code hooks (hook.py) create and end jobs; the `progress` command adds steps.
Everything stays on this machine. Python 3.9+.
"""
import fcntl
import glob
import json
import os
import re
import tempfile
import time

# The code lives in the data folder the extension set up (default ~/.claude/progress-terminal).
BASE = os.environ.get('PROGRESS_HOME') or os.path.dirname(os.path.realpath(__file__))
JOBS = os.path.join(BASE, 'jobs')
SESS = os.path.join(BASE, 'sessions')
VIEW_LOCK = os.path.join(BASE, 'view.lock')
KEEP_FINISHED = 50           # finished jobs stay as history: the newest 50, at most 7 days old
KEEP_DAYS = 7
RESUME_WITHIN = 45           # a job that ended this recently with open steps is picked up again
STALE = 3 * 3600             # a job not updated for 3 h is dropped

MASKS = [
    (re.compile(r'\b\d{8,10}:[A-Za-z0-9_-]{30,}\b'), '[token]'),
    (re.compile(r'\b(glpat|ghp|gho|ghs|github_pat|sk|sk-ant|xox[abprs]|re)[-_][A-Za-z0-9_-]{12,}'), '[token]'),
    (re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}'), '[jwt]'),
    (re.compile(r'(?i)\b(password|passwd|secret|api[_-]?key|token|bearer)(["\'\s:=]+)([^\s"\'&,]{6,})'), r'\1\2[hidden]'),
    (re.compile(r'[A-Za-z0-9+/_-]{40,}={0,2}'), '[hidden]'),
]


def mask(s):
    for rx, rep in MASKS:
        s = rx.sub(rep, s)
    return s


def short(s, n=60):
    s = mask(' '.join((s or '').split()))
    return s if len(s) <= n else s[:n - 1] + '…'


def private_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


class Lock:
    """One lock for the whole store. Gives up after 1.5 s so a tool call is never held up."""
    def __enter__(self):
        private_dir(BASE)
        private_dir(JOBS)
        self.f = open(os.path.join(JOBS, '.lock'), 'w')
        deadline = time.time() + 1.5
        while True:
            try:
                fcntl.flock(self.f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.time() > deadline:
                    self.f.close()
                    raise TimeoutError('progress store busy')
                time.sleep(0.02)

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def _write(path, data):
    private_dir(os.path.dirname(path))
    tmp = path + '.tmp%d' % os.getpid()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(data, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _read(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def path_of(jid):
    return os.path.join(JOBS, jid + '.json')


def save(job):
    job['updated'] = time.time()
    _write(path_of(job['id']), job)


def load(jid):
    return _read(path_of(jid))


def all_jobs():
    out = []
    try:
        names = os.listdir(JOBS)
    except OSError:
        return out
    for n in names:
        if n.endswith('.json'):
            j = _read(os.path.join(JOBS, n))
            if j and j.get('id'):
                out.append(j)
    return sorted(out, key=lambda j: j.get('t0', 0))


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def busy(job):
    """Something still runs for this job: a `progress run/dl` process, an agent (agents count for 2 h at most) or a
    background command or watch started by Claude Code."""
    if any(pid_alive(p) for p in job.get('pids', [])):
        return True
    now = time.time()
    if any(bg_open(r, now) for r in job.get('bg', [])):
        return True
    return any(not a.get('done') and now - a.get('t0', now) < 2 * 3600 for a in job.get('agents', []))


# ---- background jobs: Bash run_in_background and Monitor -------------------------------------------------------
# Claude Code writes what a background command (or a watch) prints to <temp>/claude-<uid>/<project>/<session>/tasks/
# <task id>.output and, when it ends, a last line: "[exited with code N]" or "[killed]". A watch that reaches its
# time limit is killed. The hooks record each one as a row (job['bg']); the rows are settled from that file.
BG_MAX = 6 * 3600            # a background command with no readable end counts as running for 6 h at most
BG_TAIL = 4096
_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
_END = re.compile(r'\n?\[(?:exited with code (-?\d+|unknown)|killed)\]\s*$')


def bg_open(r, now=None):
    now = now or time.time()
    if r.get('state'):
        return False
    limit = BG_MAX
    if r.get('kind') == 'watch' and r.get('timeout'):
        limit = r['timeout'] / 1000.0 + 300
    return now - r.get('t0', now) < limit


def bg_find_output(sid, tid, slug=''):
    """The output file of background task `tid` in session `sid`, or None."""
    if not tid or not _ID.match(str(tid)) or not sid or not _ID.match(str(sid)):
        return None
    uid = 'claude-%d' % os.getuid()
    roots = []
    for r in (os.environ.get('CLAUDE_CODE_TMPDIR'), '/private/tmp', '/tmp', tempfile.gettempdir()):
        if r and r not in roots:
            roots.append(r)
    for r in roots:
        if slug and '/' not in slug and slug not in ('.', '..'):
            p = os.path.join(r, uid, slug, sid, 'tasks', tid + '.output')
            if os.path.exists(p):
                return p
        for p in glob.glob(os.path.join(glob.escape(os.path.join(r, uid)), '*', sid, 'tasks', tid + '.output')):
            return p
    return None


def _tail(path):
    with open(path, 'rb') as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - BG_TAIL))
        return f.read().decode('utf-8', 'replace'), size


def bg_close(r, state, code=None, t1=None):
    r['state'] = state
    if code is not None:
        r['code'] = code
    r['t1'] = t1 or time.time()


def bg_refresh(job, now=None):
    """Read the output files of the job's open background rows; close the ones that ended. True if anything changed."""
    now = now or time.time()
    changed = False
    for r in job.get('bg', []):
        if r.get('state'):
            continue
        if not r.get('out') and r.get('id'):
            p = bg_find_output(job.get('sid'), r['id'], r.get('slug', ''))
            if p:
                r['out'] = p
                changed = True
        if not r.get('out'):
            if not bg_open(r, now):
                bg_close(r, 'ended', t1=now)
                changed = True
            continue
        try:
            text, size = _tail(r['out'])
            mtime = os.path.getmtime(r['out'])
        except OSError:
            # the file was there and is gone (Claude Code cleaned up): the job is over, how it ended is unknown
            bg_close(r, 'ended', t1=now)
            changed = True
            continue
        m = _END.search(text)
        body = text[:m.start()] if m else text
        if r.get('kind') == 'watch':
            last = next((l.strip() for l in reversed(body.splitlines()) if l.strip()), '')
            if last and short(last, 200) != r.get('last'):
                r['last'] = short(last, 200)
                changed = True
        if size != r.get('size'):
            r['size'] = size
            r['seen_t'] = now  # the output grew: proof of work
            changed = True
        if m:
            if m.group(1) is None:  # [killed]: a watch at its time limit expired, anything else was stopped
                lim = (r.get('timeout') or 0) / 1000.0
                expired = r.get('kind') == 'watch' and lim and mtime - r.get('t0', mtime) >= lim - 5
                bg_close(r, 'expired' if expired else 'stopped', t1=mtime)
            elif m.group(1) == 'unknown':
                bg_close(r, 'ended', t1=mtime)
            else:
                code = int(m.group(1))
                bg_close(r, 'done' if code == 0 else 'failed', code, t1=mtime)
            changed = True
        elif not bg_open(r, now):
            bg_close(r, 'ended', t1=now)
            changed = True
    return changed


def finish(job, msg=None):
    if job.get('end'):
        return
    job['end'] = time.time()
    job['waiting'] = False
    if msg:
        job['end_msg'] = msg


def prune():
    """Inside Lock(): keep the newest 50 finished jobs (7 days at most), drop live jobs untouched for 3 h; end 'waiting' jobs whose work is over."""
    now = time.time()
    jobs = all_jobs()
    finished = sorted((j for j in jobs if j.get('end')), key=lambda j: j['end'])
    too_many = {j['id'] for j in finished[:-KEEP_FINISHED]} if len(finished) > KEEP_FINISHED else set()
    for j in jobs:
        if j['id'] in too_many or j.get('end') and now - j['end'] > KEEP_DAYS * 86400 \
                or not j.get('end') and now - j.get('updated', now) > STALE and not any(bg_open(r, now) for r in j.get('bg', [])):
            try:
                os.remove(path_of(j['id']))
            except OSError:
                pass
        elif not j.get('end'):
            j['pids'] = [p for p in j.get('pids', []) if pid_alive(p)]
            dirty = bg_refresh(j, now) if any(not r.get('state') for r in j.get('bg', [])) else False
            if j.get('waiting') and not busy(j):
                finish(j)
                dirty = True
            if dirty:
                save(j)


def new_job(sid, title, jid=None):
    jid = jid or '%s-%d' % ((sid or 'job')[:8], int(time.time() * 1000) % 10**9)
    job = {'id': jid, 'sid': sid, 'title': title or 'Working', 't0': time.time(), 'end': None, 'waiting': False,
           'steps': [], 'agents': [], 'pids': [], 'actions': 0, 'log': []}
    save(job)
    return job


def live_job(sid):
    """The session's job that has not ended yet, or None."""
    for j in reversed(all_jobs()):
        if j.get('sid') == sid and not j.get('end'):
            return j
    return None


def current_job(sid):
    """The live job, or one that ended in the last 45 s with steps still open (picked up again), or None."""
    j = live_job(sid)
    if j:
        return j
    now = time.time()
    for j in reversed(all_jobs()):
        if j.get('sid') == sid and j.get('end') and now - j['end'] < RESUME_WITHIN \
                and any(s['pct'] < 100 for s in j.get('steps', [])):
            j['end'] = None
            j.pop('end_msg', None)
            return j
    return None


def session_title(sid):
    s = _read(os.path.join(SESS, sid + '.json')) if sid else None
    return (s or {}).get('title') or 'Working'


def set_session_title(sid, title):
    _write(os.path.join(SESS, sid + '.json'), {'title': title, 't': time.time()})


def add_log(job, text):
    job['log'] = (job.get('log', []) + [time.strftime('%H:%M:%S ') + short(text, 110)])[-6:]
