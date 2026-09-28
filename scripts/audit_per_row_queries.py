#!/usr/bin/env python3
"""
Guard against N+1 queries: a database call made once per row inside a loop or .map(async ...).

WHY: a page that runs one query per member, plan or loan is fine at ten rows and unusable at a thousand - and when
the calls are fired together with Promise.all, a big society means thousands of simultaneous requests every time a
screen loads. The society portal payload was doing exactly this (two queries per member, one per plan, three per
loan) and dues accrual - which runs whenever an admin opens the accounting screen - made one query per member.
Both now read each table once and group in memory (see backend/lib/coopSocietyBulk.js).

HOW THIS WORKS: a RATCHET, like audit_unbounded_queries.py. It records how many per-row database calls each file has
TODAY (scripts/per_row_queries.baseline.json) and fails if a file's number ever goes UP.

    python3 scripts/audit_per_row_queries.py                  # check
    python3 scripts/audit_per_row_queries.py --report         # list every remaining site
    python3 scripts/audit_per_row_queries.py --write-baseline # accept the current state

If a new loop is genuinely bounded - one member's own loans, a handful of platform admins - it is fine: confirm that,
then run --write-baseline. If it grows with the size of a society, read the table once instead (fetchAllRows in
backend/lib/coopPaginate.js, grouping helpers in coopSocietyBulk.js). Heuristic scanner, not a proof.
"""
import argparse, json, os, re, sys
from collections import Counter

DB_AWAIT = re.compile(r"await\s+(?:[\w.]*\.)?(?:db\.from\(|compute\w+\(db|record\w+\(db|apply\w+\(db|resolve\w+\(db|post\w+\(db|get\w+\(db)")

def match(src, i, o, c):
    d = 0
    while i < len(src):
        if src[i] == o: d += 1
        elif src[i] == c:
            d -= 1
            if d == 0: return i
        i += 1
    return -1

def scan(root):
    out = []
    for d, _, fs in os.walk(root):
        if 'node_modules' in d or os.sep + 'tests' in d: continue
        for f in fs:
            if not f.endswith('.js'): continue
            p = os.path.join(d, f); rel = os.path.relpath(p, root).replace(os.sep, '/')
            src = open(p, encoding='utf-8', errors='ignore').read(); bodies = []
            for m in re.finditer(r"\bfor\s*\(", src):
                e = match(src, m.end() - 1, '(', ')')
                if e < 0: continue
                j = e + 1
                while j < len(src) and src[j].isspace(): j += 1
                if j < len(src) and src[j] == '{':
                    k = match(src, j, '{', '}')
                    if k > 0: bodies.append(('for', m.start(), src[j:k]))
            for m in re.finditer(r"\.(map|forEach)\(\s*async", src):
                e = match(src, m.start() + len(m.group(1)) + 1, '(', ')')
                if e > 0: bodies.append(('map', m.start(), src[m.start():e]))
            for kind, pos, body in bodies:
                n = len(DB_AWAIT.findall(body))
                if n: out.append(dict(file=rel, line=src[:pos].count('\n') + 1, kind=kind, calls=n))
    return out

def main():
    ap = argparse.ArgumentParser(); here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--root', default=os.path.join(here, '..', 'backend'))
    ap.add_argument('--baseline', default=os.path.join(here, 'per_row_queries.baseline.json'))
    ap.add_argument('--write-baseline', action='store_true'); ap.add_argument('--report', action='store_true')
    a = ap.parse_args(); found = scan(a.root); counts = Counter(f['file'] for f in found)
    if a.write_baseline:
        json.dump(dict(sorted(counts.items())), open(a.baseline, 'w'), indent=1)
        print(f"baseline written: {sum(counts.values())} known per-row query sites across {len(counts)} files"); return 0
    if a.report:
        for f in sorted(found, key=lambda f: (f['file'], f['line'])): print(f"{f['file']}:{f['line']}  ({f['kind']}, {f['calls']} call{'s' if f['calls'] != 1 else ''} per row)")
        print(f"\n{len(found)} per-row query sites in {len(counts)} files."); return 0
    base = json.load(open(a.baseline)) if os.path.exists(a.baseline) else {}
    worse = {k: (counts[k], base.get(k, 0)) for k in counts if counts[k] > base.get(k, 0)}
    if not worse: print(f"OK: no new per-row queries ({sum(counts.values())} known, {sum(base.values())} in baseline)."); return 0
    print("NEW per-row database call(s) inside a loop or .map(async ...).\nIf the loop grows with a society's size, read the table once and group in memory (see the top of this file).\n")
    for k, (n, b) in worse.items():
        print(f"  {k}: {n} now vs {b} allowed")
        for f in found:
            if f['file'] == k: print(f"      line {f['line']} ({f['kind']}, {f['calls']} per row)")
    return 1

if __name__ == '__main__': sys.exit(main())
