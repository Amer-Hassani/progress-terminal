"""Live progress screen: running jobs on top, everything finished below as history, redrawn every second.
Opened by the VS Code extension without taking keyboard focus. It never closes by itself: only you close it.
Scroll with the mouse wheel, the arrow keys, Page Up/Down, Home/End. Python 3.9+.
"""
import atexit
import os
import select
import shutil
import signal
import sys
import termios
import time
import tty

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import core  # noqa: E402

G, Y, D, B, R0 = '\033[92m', '\033[93m', '\033[2m', '\033[1m', '\033[0m'
KEYS = {b'\x1b[A': -1, b'\x1bOA': -1, b'\x1b[B': 1, b'\x1bOB': 1, b'k': -1, b'j': 1}
PAGE = {b'\x1b[5~': -1, b'\x1b[6~': 1, b' ': 1}
_tty = None


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


def bar(p, w, done):
    f = int(round(p / 100.0 * w))
    return (G if done else Y) + '█' * f + D + '░' * (w - f) + R0


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
    for a in j.get('agents', []):
        steps.append({'name': 'agent: ' + a['name'], 'pct': 100 if a.get('done') else 0, 'w': 1, 'detail': ''})
    ended = j.get('end')
    el = (ended or now) - j.get('t0', now)
    if ended:
        out.append('%s✔ %s%s  %sdone in %s · finished %s%s' % (G + B, j['title'], R0, D, fmt(el), when(ended), R0))
    elif j.get('waiting'):
        out.append('%s%s%s  %swaiting for background work · %s%s' % (B, j['title'], R0, D, fmt(el), R0))
    else:
        out.append('%s%s%s  %s%s%s' % (B, j['title'], R0, D, fmt(el), R0))
    if steps:
        tw = sum(s.get('w', 1) for s in steps) or 1
        total = sum(s['pct'] * s.get('w', 1) for s in steps) / tw
        left = ''
        if 0 < total < 100 and not ended:
            left = '   about %s left' % fmt(el / total * (100 - total))
        out.append('  %sTOTAL %6.2f%%%s  %s%s%s%s' % (B, total, R0, bar(total, W, total >= 100), D, left, R0))
        for i, s in enumerate(steps, 1):
            done = s['pct'] >= 100
            mark = G + '✔' + R0 if done else (Y + '▸' + R0 if s['pct'] > 0 and not ended else D + '·' + R0)
            out.append('  %s %d. %-30s %6.2f%%  %s' % (mark, i, s['name'][:30], s['pct'], bar(s['pct'], W // 2, done)))
            detail = s.get('detail', '')
            if ended and not done:
                detail = 'not finished' + (' · ' + detail.replace('(not finished)', '').strip() if detail.strip(' ()') and 'not finished' not in detail else '')
            if detail and not done:
                out.append('       ' + D + detail[:cols - 10] + R0)
    else:
        out.append('  %s%d actions%s' % (D, j.get('actions', 0), R0))
    for line in j.get('log', [])[-3:]:
        out.append('  ' + D + line[:cols - 4] + R0)
    if j.get('end_msg'):
        out.append('  ' + G + j['end_msg'][:cols - 4] + R0)
    return out


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
                                                                          (b'\x1b[F', 'end'), (b'\x1b[4~', 'end'), (b'G', 'end')]:
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
    global _tty
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
    while True:
        now = time.time()
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
            lines += section(j, cols, W, now) + ['']
        if not live:
            lines += [D + 'Waiting for the next job…' + R0, '']
        if done:
            lines += [D + '── Earlier (%d) ' % len(done) + '─' * max(0, cols - 16) + R0, '']
            for j in done:
                lines += section(j, cols, W, now) + ['']
        if live and now - last_key > 10:
            offset = 0  # nobody is scrolling: show the running job, not old history
        body = max(1, rows - 2)
        offset = max(0, min(offset, len(lines) - body))
        shown = lines[offset:offset + body]
        hint = 'scroll: wheel / ↑ ↓ / PgUp PgDn / Home End' if len(lines) > body else ''
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
        if jump == 'top':
            offset = 0
        elif jump == 'end':
            offset = len(lines)
        offset += dl + dp * max(1, body - 2)


if __name__ == '__main__':
    main()
