"""Live progress screen: running jobs on top, everything finished below as history, redrawn every second.
Opened by the VS Code extension without taking keyboard focus. It never closes by itself: only you close it.
Scroll with the mouse wheel, the arrow keys, Page Up/Down, Home/End. Python 3.9+.
"""
import atexit
import math
import re
import os
import select
import shutil
import signal
import sys
import termios
import time
import unicodedata
import tty

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import core  # noqa: E402

G, Y, D, B, R0 = '\033[92m', '\033[93m', '\033[2m', '\033[1m', '\033[0m'
KEYS = {b'\x1b[A': -1, b'\x1bOA': -1, b'\x1b[B': 1, b'\x1bOB': 1, b'k': -1, b'j': 1}
PAGE = {b'\x1b[5~': -1, b'\x1b[6~': 1, b' ': 1}
_tty = None
show_all = False  # 'a' key: list finished agents one by one instead of one folded line


def lock_or_exit():
    """Exactly one view per machine, whatever number of VS Code windows."""
    try:
        pid = int(open(core.VIEW_LOCK).read().strip() or 0)
    except (OSError, ValueError):
        pid = 0
    if pid and pid != os.getpid() and core.pid_alive(pid):
        sys.exit(0)
    fd = os.open(core.VIEW_LOCK, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.chmod(core.VIEW_LOCK, 0o600)  # an older lock may still be 644
    with os.fdopen(fd, 'w') as f:
        f.write(str(os.getpid()))


def unlock():
    try:
        if int(open(core.VIEW_LOCK).read().strip() or 0) == os.getpid():
            os.remove(core.VIEW_LOCK)
    except (OSError, ValueError):
        pass


def restore():
    if _tty:
        try:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, _tty)
        except termios.error:
            pass
    sys.stdout.write('\033[?25h\033[?1049l')
    sys.stdout.flush()


def quit_(*_):
    restore()
    unlock()
    os._exit(0)


def bar(real, w, done, moving=False, shown=None):
    """Real part solid, the estimate on top of it lighter (▓), the rest empty. Nothing moves inside a bar."""
    if done:
        return G + '█' * w + R0
    shown = real if shown is None else shown
    real = min(real, shown)
    f = int(round(real / 100.0 * w))
    e = max(0, int(round(shown / 100.0 * w)) - f)
    rest = w - f - e
    return Y + '█' * f + R0 + D + Y + '▓' * e + R0 + D + '░' * rest + R0


# ---- estimate between real reports -------------------------------------------------------------------------
# A real number comes only from `progress set/done` (or a finished agent). Between two reports the shown value
# eases from the last real value toward a ceiling short of 100 %, and it only advances while there is proof of
# work: a tool call or agent in flight, a `progress run/dl` process alive, or an event in the last IDLE seconds.
# It never goes backwards (a lower real report keeps the shown value), never reaches 100 % before `done`,
# and freezes as soon as the proof stops. Estimated values carry a "~" and a lighter colour.
IDLE = 90          # tool-finished events known: nothing new for 90 s = idle
STUCK = 600        # no tool-finished events (hook not wired): a call with no news for 10 min = treat as stuck
EST = {}           # key -> {'real', 'base', 'a' (active seconds since the last real value), 'shown'}
EST_FILE = os.path.join(core.BASE, 'view-state.json')
_dt = 0.0


def est_load():
    try:
        import json
        with open(EST_FILE) as f:
            EST.update(json.load(f))
    except (OSError, ValueError):
        pass


def est_save(keep):
    try:
        import json
        for k in [k for k in EST if k.split('|', 1)[0] not in keep]:
            del EST[k]
        tmp = EST_FILE + '.tmp'
        with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
            json.dump(EST, f)
        os.replace(tmp, EST_FILE)
    except (OSError, ValueError):
        pass


def estimate(key, real, advance, tau):
    st = EST.get(key)
    if st is None:
        st = EST[key] = {'real': real, 'base': real, 'a': 0.0, 'shown': real}
    if real != st['real']:
        st['real'], st['base'], st['a'] = real, max(real, st['shown']), 0.0
    if real >= 100:
        st['shown'] = 100.0
        return 100.0
    if advance:
        st['a'] += _dt
    base = st['base']
    ceil = base + 0.85 * (99.0 - base) if base < 99 else base
    v = base + (ceil - base) * (1 - math.exp(-st['a'] / max(tau, 1)))
    st['shown'] = max(st['shown'], v, real)
    return st['shown']


def chase(key, target, cap):
    """The number on screen travels to its target instead of teleporting, at `cap` points per second at most;
    small gaps close in one frame, so the number stops the moment the estimate stops. Used for a step closing far ahead of its last report
    and for the TOTAL when steps are added (that may go down)."""
    st = EST.setdefault(key, {'v': target})
    v = st.get('v', target)
    gap = target - v
    if abs(gap) < 0.0005:
        v = target
    else:
        mv = min(abs(gap), cap * _dt)
        v += mv if gap > 0 else -mv
    st['v'] = v
    return v


def step_tau(j, s, now):
    """How fast to ease: the step's own reported speed, else the average length of this job's finished steps."""
    t0, tr, pct = s.get('t0'), s.get('tr'), s['pct']
    if t0 and tr and pct > 0 and tr - t0 > 5:
        return min(3600, max(30, (100 - pct) / (pct / (tr - t0))))
    ends = sorted(x['t1'] for x in j.get('steps', []) if x.get('t1'))
    if ends:
        b = [j.get('t0', now)] + ends
        return min(1800, max(30, (b[-1] - b[0]) / len(ends)))
    return 180


def activity(j, now):
    """(moving, text): is there proof that work is going on right now, and what it is."""
    if j.get('end'):
        return False, ''
    agents = [a for a in j.get('agents', []) if not a.get('done') and now - a.get('t0', now) < 2 * 3600]
    procs = any(core.pid_alive(p) for p in j.get('pids', []))
    ev = j.get('ev_t') or j.get('updated') or j.get('t0', now)
    quiet = now - ev
    bg = []
    if agents:
        bg.append('%d agent%s running · %s' % (len(agents), '' if len(agents) == 1 else 's', fmt(now - min(a.get('t0', now) for a in agents))))
    if procs:
        bg.append('command running')
    if j.get('waiting'):
        return bool(agents or procs), ('waiting for ' + ' · '.join(bg)) if bg else 'nothing running · numbers paused'
    tool = j.get('tool')
    if tool:
        age = now - tool.get('t', now)
        what = ('running: %s · %s' if j.get('post') else 'last action: %s · %s ago') % (tool.get('name', ''), fmt(age))
        if quiet > STUCK and not bg:
            return False, 'no news for %s (%s) · numbers paused, may be stuck' % (fmt(quiet), what)
        return True, ' · '.join([what] + bg)
    if quiet < IDLE or bg:
        return True, ' · '.join(['thinking · last event %s ago' % fmt(quiet)] + bg)
    return False, 'no tool activity for %s · numbers paused' % fmt(quiet)


def pct_txt(real, shown):
    if abs(shown - real) > 0.0005:
        return '%s~%7.3f%%%s' % (D + Y, shown, R0)
    return ' %7.3f%%' % real


def fmt(sec):
    sec = int(max(0, sec))
    if sec >= 3600:
        return '%dh %02dm' % (sec // 3600, sec % 3600 // 60)
    return '%dm %02ds' % (sec // 60, sec % 60) if sec >= 60 else '%ds' % sec


def when(t):
    lt = time.localtime(t)
    return time.strftime('%H:%M', lt) if time.strftime('%d/%m/%Y', lt) == time.strftime('%d/%m/%Y') \
        else time.strftime('%d/%m/%Y %H:%M', lt)


def section(j, cols, W, now):
    out = []
    steps = list(j.get('steps', []))
    plain = len(steps)
    for a in j.get('agents', []):
        steps.append({'name': 'agent: ' + a['name'], 'pct': 100 if a.get('done') else 0, 'w': 1,
                      'detail': 'stopped without a report' if a.get('stopped') else '', 'stopped': a.get('stopped'),
                      'key': 'agent:%s:%s' % (a['name'], a.get('t0'))})
    ended = j.get('end')
    el = (ended or now) - j.get('t0', now)
    moving, doing = activity(j, now)
    # which steps are being worked on (live jobs only): running agents, the steps that are part-way,
    # and, when none is part-way, the first step not done yet (most sessions only call steps + done, never set)
    active = set()
    if not ended:
        part = [i for i, s in enumerate(steps[:plain]) if 0 < s['pct'] < 100]
        first = next((i for i, s in enumerate(steps[:plain]) if s['pct'] < 100), None)
        active.update(part or ([first] if first is not None else []))
        active.update(i for i in range(plain, len(steps)) if steps[i]['pct'] < 100)
        since = max([j.get('t0', now)] + [s.get('t1') or 0 for s in steps[:plain]])
    shown = []
    for i, s in enumerate(steps):
        if ended:
            shown.append(s['pct'])
        else:
            tau = step_tau(j, s, now) if i < plain else 300
            k = '%s|%s' % (j['id'], s.get('key') or s['name'])
            shown.append(estimate(k, s['pct'], moving and i in active, tau))
    if ended:
        out.append('%s✔ %s%s  %sdone in %s · finished %s%s' % (G + B, j['title'], R0, D, fmt(el), when(ended), R0))
    elif j.get('waiting'):
        out.append('%s%s%s  %swaiting for background work · %s%s' % (B, j['title'], R0, D, fmt(el), R0))
    else:
        out.append('%s%s%s  %s%s%s' % (B, j['title'], R0, D, fmt(el), R0))
    if steps:
        tw = sum(s.get('w', 1) for s in steps) or 1
        real = sum(s['pct'] * s.get('w', 1) for s in steps) / tw
        total = sum(v * s.get('w', 1) for v, s in zip(shown, steps)) / tw
        if not ended:
            total = chase(j['id'] + '|TOTAL', total, 2.0)
            shown = [chase('%s|%s|d' % (j['id'], s.get('key') or s['name']), v, 5.0) for v, s in zip(shown, steps)]
        left = ''
        # time left only from real reports, and only when no earlier step was skipped (open 0 % steps before
        # a step that has moved make any estimate nonsense)
        skipped = any(s['pct'] == 0 and any(t['pct'] > 0 for t in steps[i + 1:plain]) for i, s in enumerate(steps[:plain]))
        pw = sum(s.get('w', 1) for s in steps[:plain]) or 1
        preal = sum(s['pct'] * s.get('w', 1) for s in steps[:plain]) / pw  # agents report no %: left out of the time left
        if plain and 10 <= preal < 100 and not ended and not skipped:
            left = '   about %s left' % fmt(el / preal * (100 - preal))
        rep = ('   %sreported %.3f%%%s' % (D, real, R0)) if abs(total - real) > 0.0005 else ''
        out.append('  %sTOTAL%s%s  %s%s%s%s%s' % (B, R0, pct_txt(real, total), bar(real, W, total >= 99.9995, moving, total), rep, D, left, R0))
        if doing:
            out.append('  ' + (D if moving else Y) + 'now: ' + doing[:cols - 9] + R0)
        finished = [i for i in range(plain + 1, len(steps) + 1)
                    if steps[i - 1]['pct'] >= 100 and shown[i - 1] >= 99.9995]
        fold = len(finished) > 1 and not show_all
        order = list(range(1, plain + 1))
        if fold:
            order.append(None)  # one line for all finished agents, then the running ones
        order += [i for i in range(plain + 1, len(steps) + 1) if not (fold and i in finished)]
        for i in order:
            if i is None:
                nst = sum(1 for k in finished if steps[k - 1].get('stopped'))
                out.append('  %s✔%s %s%d agents done%s · press a to list them%s' % (
                    G, R0, D, len(finished), (' (%d stopped without a report)' % nst) if nst else '', R0))
                continue
            s = steps[i - 1]
            done = s['pct'] >= 100 and shown[i - 1] >= 99.9995
            on = (i - 1) in active
            mark = G + '✔' + R0 if done else ((Y if moving else D) + '▸' + R0 if on or s['pct'] >= 100 else D + '·' + R0)
            nw = max(10, min(30, cols - 22 - W // 2))  # name column shrinks before anything gets cut
            out.append('  %s %2d. %-*s %s  %s' % (mark, i, nw, core.short(s['name'], nw), pct_txt(s['pct'], shown[i - 1]),
                                                bar(s['pct'], W // 2, done, on and moving, shown[i - 1])))
            detail = s.get('detail', '')
            if on and not detail and i <= plain:
                detail = 'working · %s' % fmt(now - since)
            if ended and not done:
                detail = 'not finished' + (' · ' + detail.replace('(not finished)', '').strip() if detail.strip(' ()') and 'not finished' not in detail else '')
            if detail and (not done or s.get('stopped')):
                out.append('       ' + D + detail[:cols - 10] + R0)
    elif not ended:
        out.append('  %s%d actions%s' % (D, j.get('actions', 0), R0))
        if doing:
            out.append('  ' + (D if moving else Y) + 'now: ' + doing[:cols - 9] + R0)
    else:
        out.append('  %s%d actions%s' % (D, j.get('actions', 0), R0))
    for line in j.get('log', [])[-3:]:
        out.append('  ' + D + line[:cols - 4] + R0)
    if j.get('end_msg'):
        out.append('  ' + G + j['end_msg'][:cols - 4] + R0)
    return out


ANSI = re.compile(r'\033\[[0-9;?]*[A-Za-z]')


def clip(line, cols):
    """Cut a line to the terminal width, colour codes not counted. A line wider than the terminal wraps onto a
    second row: the bars break up and the screen no longer matches the rows the view counted (scroll stops)."""
    if cols <= 0:
        return ''
    out, n, i = [], 0, 0
    while i < len(line):
        m = ANSI.match(line, i)
        if m:
            out.append(m.group())
            i = m.end()
            continue
        cw = 2 if unicodedata.east_asian_width(line[i]) in ('W', 'F') else 1
        if n + cw > cols:
            n = cols
            break
        out.append(line[i])
        n += cw
        i += 1
    return ''.join(out) + (R0 if n >= cols else '')


def safe_section(j, cols, W, now):
    """One odd job file must never kill the view (a dead view = an empty Progress tab until the next task)."""
    try:
        return section(j, cols, W, now)
    except Exception as e:
        return ['%s%s  (cannot show this job: %s)%s' % (D, str(j.get('title') or j.get('id'))[:60], type(e).__name__, R0)]


def code_stamp():
    here = os.path.dirname(os.path.realpath(__file__))
    try:
        return tuple(os.stat(os.path.join(here, n)).st_mtime for n in ('view.py', 'core.py'))
    except OSError:
        return None


def read_keys(timeout):
    """Wait up to `timeout` for keys; return the scroll change in lines (pages as None-tagged)."""
    if not _tty:
        time.sleep(timeout)
        return 0, 0, None
    r, _, _ = select.select([sys.stdin], [], [], timeout)
    if not r:
        return 0, 0, None
    data = os.read(sys.stdin.fileno(), 256)
    lines = pages = 0
    jump = None
    i = 0
    while i < len(data):
        for seq, n in list(KEYS.items()) + [(k, None) for k in PAGE] + [(b'\x1b[H', 'top'), (b'\x1b[1~', 'top'), (b'g', 'top'),
                                                                          (b'\x1b[F', 'end'), (b'\x1b[4~', 'end'), (b'G', 'end'), (b'a', 'all')]:
            if data[i:i + len(seq)] == seq:
                if seq in KEYS:
                    lines += KEYS[seq]
                elif seq in PAGE:
                    pages += PAGE[seq]
                else:
                    jump = n
                i += len(seq)
                break
        else:
            i += 1
    return lines, pages, jump


def main():
    global _tty, _dt, show_all
    lock_or_exit()
    atexit.register(unlock)
    for sg in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sg, quit_)
    if sys.stdin.isatty():
        _tty = termios.tcgetattr(sys.stdin.fileno())
        tty.setcbreak(sys.stdin.fileno())
    sys.stdout.write('\033[?1049h\033[?25l\033[2J')
    sys.stdout.flush()
    atexit.register(restore)
    offset, last, next_draw = 0, None, 0.0
    last_key = 0.0
    stamp = code_stamp()
    est_load()
    prev, saved = time.time(), 0.0
    while True:
        now = time.time()
        _dt, prev = min(3.0, max(0.0, now - prev)), now
        if stamp and code_stamp() not in (None, stamp):
            # view.py or core.py was updated: restart in place (same process id, same terminal, no focus change)
            if _tty:
                try:
                    termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, _tty)
                except termios.error:
                    pass
            sys.stdout.flush()
            os.execv(sys.executable, [sys.executable, '-I', os.path.realpath(__file__)])
        try:
            with core.Lock():
                core.prune()
            jobs = core.all_jobs()
        except Exception:
            jobs = []
        sz = shutil.get_terminal_size((100, 30))
        cols, rows = sz.columns, sz.lines
        W = max(20, min(50, cols - 40))
        # running jobs first, then jobs waiting on background work; newest first in each
        live = sorted((j for j in jobs if not j.get('end')),
                      key=lambda j: (bool(j.get('waiting')), -j.get('t0', 0)))
        done = sorted((j for j in jobs if j.get('end')), key=lambda j: -j['end'])
        lines = []
        for j in live:
            lines += safe_section(j, cols, W, now) + ['']
        if not live:
            lines += [D + 'Waiting for the next job…' + R0, '']
        if done:
            lines += [D + '── Earlier (%d) ' % len(done) + '─' * max(0, cols - 16) + R0, '']
            for j in done:
                lines += safe_section(j, cols, W, now) + ['']
        if live and now - last_key > 10:
            offset = 0  # nobody is scrolling: show the running job, not old history
        body = max(1, rows - 2)
        offset = max(0, min(offset, len(lines) - body))
        shown = [clip(l, cols - 1) for l in lines[offset:offset + body]]
        if now - saved > 5:
            est_save({j['id'] for j in live})
            saved = now
        hint = 'scroll: wheel / ↑ ↓ / PgUp PgDn / Home End' if len(lines) > body else ''
        if any(re.search(r'~ *[0-9]', l) for l in shown):
            hint = '~ = estimate between reports, moves only while work runs' + ('  ·  ' + hint if hint else '')
        if show_all:
            hint = 'a = fold finished agents again' + ('  ·  ' + hint if hint else '')
        if offset:
            hint = 'line %d of %d · Home = back to the top' % (offset + 1, len(lines))
        txt = '\033[H' + ''.join(l + '\033[K\n' for l in shown) + '\033[J' + \
              '\033[%d;1H' % rows + D + hint[:cols - 1] + R0 + '\033[K'
        if txt != last:
            sys.stdout.write(txt)
            sys.stdout.flush()
            last = txt
        wait = max(0.05, 1 - (time.time() % 1) + 0.02)
        dl, dp, jump = read_keys(wait)
        if dl or dp or jump:
            last_key = time.time()
        if jump == 'all':
            show_all = not show_all
        elif jump == 'top':
            offset = 0
        elif jump == 'end':
            offset = len(lines)
        offset += dl + dp * max(1, body - 2)


if __name__ == '__main__':
    main()
