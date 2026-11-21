"""progress — feed the Progress Terminal view.

  progress steps "a|b|c" [1,2,1]       add steps to this session's job (starts the job if none)
  progress set NAME PCT ["detail"]     a step's percent (0-100)
  progress done NAME                   step finished
  progress log "text"                  a line under the bars
  progress title "text"                rename the job
  progress end ["message"]             job finished (vanishes 30 s later)
  progress run "label" -- CMD ...      run CMD, show its % / last line every second, keep the job open while it runs
  progress dl URL DEST ["label"]       download with %, MB, speed and time left, every second
  progress status                      list jobs

The job is this Claude Code session's (CLAUDE_CODE_SESSION_ID). Elsewhere pass -j JOBID or set PROGRESS_JOB.
"""
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import core  # noqa: E402


def die(msg):
    sys.stderr.write('progress: ' + msg + '\n')
    sys.exit(2)


def resolve(argv):
    jid = os.environ.get('PROGRESS_JOB')
    if len(argv) > 1 and argv[0] == '-j':
        jid, argv = argv[1], argv[2:]
    return jid, argv


def get_job(jid, create=True):
    """Inside Lock(): the job to write to."""
    if jid:
        j = core.load(jid)
        if j and not j.get('end'):
            return j
        if not create:
            die('no live job ' + jid)
        return core.new_job('manual', jid, jid)
    sid = os.environ.get('CLAUDE_CODE_SESSION_ID')
    if not sid:
        die('no session id: pass -j JOBID or set PROGRESS_JOB')
    j = core.current_job(sid)
    if not j:
        if not create:
            die('no live job for this session')
        j = core.new_job(sid, core.session_title(sid))
    return j


def step(job, name):
    for s in job['steps']:
        if s['name'] == name:
            return s
    names = ', '.join(s['name'] for s in job['steps']) or 'none'
    die('no step "%s" in this job (steps: %s)' % (name, names))


def update(jid, fn):
    with core.Lock():
        j = get_job(jid)
        fn(j)
        j['ev_t'] = time.time()  # a report from the session is proof that work is moving
        core.save(j)
        return j


def add_steps(j, names, weights):
    have = {s['name'] for s in j['steps']}
    for n, w in zip(names, weights):
        if n not in have:
            j['steps'].append({'name': n, 'pct': 0, 'w': float(w), 'detail': '', 't0': None, 't1': None})


def set_pct(j, name, pct, detail=None):
    s = step(j, name)
    new = max(0.0, min(100.0, float(pct)))
    if new != s['pct']:
        s['tr'] = time.time()  # when this real number was reported (the view's estimate restarts from here)
    s['pct'] = new
    if detail is not None:
        s['detail'] = core.short(detail, 110)
    if s['t0'] is None and s['pct'] > 0:
        s['t0'] = time.time()
    if s['pct'] >= 100 and s['t1'] is None:
        s['t1'] = time.time()
        s['detail'] = ''


def agent_row(j, name):
    """The newest agent row with this name (exact, else the first that starts with it)."""
    rows = list(reversed(j.get('agents', [])))
    r = next((x for x in rows if x['name'] == name), None) or next((x for x in rows if x['name'].startswith(name)), None)
    if not r:
        die('no agent named %r in this job' % name)
    return r


def mb(n):
    return '%.1f MB' % (n / 1048576.0)


def eta(sec):
    sec = int(max(0, sec))
    return '%dm %02ds' % (sec // 60, sec % 60) if sec >= 60 else '%ds' % sec


def run(jid, label, cmd):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    update(jid, lambda j: (add_steps(j, [label], [1]), j['pids'].append(proc.pid)))
    last = {'line': '', 'pct': None}

    def reader():
        buf = b''
        while True:
            ch = proc.stdout.read1(4096) if hasattr(proc.stdout, 'read1') else proc.stdout.read(1)
            if not ch:
                break
            sys.stdout.buffer.write(ch)
            sys.stdout.flush()
            buf += ch
            parts = re.split(rb'[\r\n]', buf)
            buf = parts[-1][-4000:]
            for p in parts[:-1]:
                t = p.decode('utf-8', 'replace').strip()
                if t:
                    last['line'] = t
                    m = re.findall(r'(\d{1,3}(?:\.\d+)?)\s?%', t)
                    if m and float(m[-1]) <= 100:
                        last['pct'] = float(m[-1])
    th = threading.Thread(target=reader, daemon=True)
    th.start()
    t0 = time.time()
    while proc.poll() is None:
        time.sleep(1)
        detail = '%s · %s' % (eta(time.time() - t0), last['line'])
        pct = last['pct'] if last['pct'] is not None else 0
        update(jid, lambda j: set_pct(j, label, min(pct, 99), detail))
    th.join(2)
    rc = proc.returncode

    def fin(j):
        if rc == 0:
            set_pct(j, label, 100)
        else:
            step(j, label)['detail'] = 'failed (exit %d) · %s' % (rc, core.short(last['line'], 80))
        j['pids'] = [p for p in j['pids'] if p != proc.pid]
    update(jid, fin)
    return rc


def dl(jid, url, dest, label):
    update(jid, lambda j: add_steps(j, [label], [1]))
    req = urllib.request.Request(url, headers={'User-Agent': 'progress-dl'})
    t0 = last = time.time()
    done = 0
    part = dest + '.part'
    with urllib.request.urlopen(req) as r, open(part, 'wb') as f:
        total = int(r.headers.get('Content-Length') or 0)
        while True:
            chunk = r.read(65536)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            now = time.time()
            if now - last >= 1:
                last = now
                speed = done / max(now - t0, 0.001)
                if total:
                    d = '%s / %s · %.0f KB/s · %s left' % (mb(done), mb(total), speed / 1024, eta((total - done) / max(speed, 1)))
                    p = done * 100.0 / total
                else:
                    d = '%s · %.0f KB/s · size unknown' % (mb(done), speed / 1024)
                    p = 0
                update(jid, lambda j: set_pct(j, label, min(p, 99), d))
    os.replace(part, dest)
    update(jid, lambda j: set_pct(j, label, 100))
    print('saved %s (%s)' % (dest, mb(done)))


def main(argv):
    jid, argv = resolve(argv)
    if not argv or argv[0] in ('-h', '--help', 'help'):
        print(__doc__)
        return 0
    cmd, a = argv[0], argv[1:]
    if cmd == 'steps':
        names = [n for n in a[0].split('|') if n]
        w = [float(x) for x in a[1].split(',')] if len(a) > 1 else [1] * len(names)
        if len(w) != len(names):
            die('%d steps but %d weights' % (len(names), len(w)))
        j = update(jid, lambda j: add_steps(j, names, w))
        print('job %s: %d steps' % (j['id'], len(j['steps'])))
    elif cmd == 'set':
        update(jid, lambda j: set_pct(j, a[0], a[1], a[2] if len(a) > 2 else None))
    elif cmd == 'done':
        update(jid, lambda j: set_pct(j, a[0], 100))
    elif cmd == 'tasks':
        names = [n for n in a[1].split('|') if n]
        update(jid, lambda j: agent_row(j, a[0]).__setitem__('tasks', [{'name': n, 'done': False} for n in names]))
    elif cmd == 'task':
        def tick(j):
            t = next((t for t in agent_row(j, a[0]).get('tasks', []) if t['name'] == a[1]), None)
            if not t:
                die('no task %r under agent %r' % (a[1], a[0]))
            t['done'] = True
        update(jid, tick)
    elif cmd == 'log':
        update(jid, lambda j: core.add_log(j, a[0]))
    elif cmd == 'title':
        update(jid, lambda j: j.__setitem__('title', core.short(a[0])))
    elif cmd == 'end':
        with core.Lock():
            j = get_job(jid, create=False)
            core.finish(j, a[0] if a else None)
            core.save(j)
    elif cmd == 'run':
        if '--' not in a or a.index('--') != 1:
            die('usage: progress run "label" -- CMD ...')
        return run(jid, a[0], a[2:])
    elif cmd == 'dl':
        dl(jid, a[0], a[1], a[2] if len(a) > 2 else os.path.basename(a[1]))
    elif cmd == 'status':
        for j in core.all_jobs():
            state = 'finished' if j.get('end') else ('waiting' if j.get('waiting') else 'live')
            print('%s  %-8s %s  steps=%d actions=%d' % (j['id'], state, j['title'], len(j['steps']), j.get('actions', 0)))
    else:
        die('unknown command ' + cmd)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
