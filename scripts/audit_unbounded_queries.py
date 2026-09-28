#!/usr/bin/env python3
"""
Guard against silent 1,000-row truncation in backend Supabase queries.

WHY: PostgREST returns at most 1,000 rows per request by default, silently - no
error, no warning. A query that reads "all rows" and then sums, counts or loops
over them is right until a society outgrows 1,000 rows, then quietly wrong:
dividends computed on partial data, accruals booked short, nightly jobs
skipping members. Anything that must be complete has to page:

    const { fetchAllRows } = require('../../lib/coopPaginate');
    const rows = await fetchAllRows(() => db.from('t').select('...').eq('coop_id', id).order('id'));

(order by the table's REAL key: `id` for most tables, `coin_id` for coins,
`coop_id` for coop_societies.)

HOW THIS WORKS: it is a RATCHET. It records how many society-wide / platform-wide
unbounded reads each file+table has TODAY (scripts/unbounded_queries.baseline.json)
and fails if that number ever goes UP. Fixing one and re-running with
--write-baseline lowers the bar; nothing can quietly raise it.

    python3 scripts/audit_unbounded_queries.py                  # check (exit 1 if a new one was added)
    python3 scripts/audit_unbounded_queries.py --report         # list everything still unbounded, by risk
    python3 scripts/audit_unbounded_queries.py --write-baseline # accept the current state

Entity-scoped reads (one member's / one loan's rows) are not counted: they are
bounded by that entity, not by the size of a society. This is a heuristic scanner,
not a proof - treat a clean run as "no NEW obvious cases", and re-read the report
before a release that targets much larger societies.
"""
import argparse, json, os, re, sys
from collections import Counter

BOUNDED = re.compile(r"\.(maybeSingle|single|limit|range)\(|head:\s*true")
WRITE = re.compile(r"\.(insert|update|upsert|delete)\(")
TINY_CONFIG = {'coop_chart_of_accounts', 'coop_subscription_plan_catalog', 'coop_statutory_config', 'zillion_chart_of_accounts'}
ENTITY_KEYS = "member_id|loan_id|savings_plan_id|scheme_id|scheme_member_id|user_id|zillion_id|agent_id|batch_id|dividend_run_id|member_investment_id|entitlement_id|financial_year_id|account_id|journal_entry_id|cycle_id"

def chain_end(src, start):
    depth, i, instr = 0, start, None
    while i < len(src):
        ch = src[i]
        if instr:
            if ch == '\\': i += 2; continue
            if ch == instr: instr = None
        else:
            if ch in '\'"`': instr = ch
            elif ch in '([{': depth += 1
            elif ch in ')]}': depth -= 1
            elif ch == ';' and depth <= 0: return i
            elif depth < 0: return i
        i += 1
    return len(src)

def scan(root):
    out = []
    for d, _, fs in os.walk(root):
        if 'node_modules' in d or os.sep + 'tests' in d: continue
        for f in fs:
            if not f.endswith('.js') or f.startswith('_'): continue
            path = os.path.join(d, f); rel = os.path.relpath(path, root).replace(os.sep, '/')
            src = open(path, encoding='utf-8', errors='ignore').read(); lines = src.split('\n')
            for m in re.finditer(r"\.from\((['\"])([a-z_]+)\1\)", src):
                table = m.group(2); s = m.start(); e = chain_end(src, s); chain = src[s:e]
                if table in TINY_CONFIG or WRITE.search(chain) or not re.search(r"\.select\(", chain) or BOUNDED.search(chain): continue
                if 'fetchAllRows(' in src[max(0, s - 90):s]: continue
                if re.search(r"\.eq\(\s*['\"]" + "(" + ENTITY_KEYS + r")['\"]", chain) and not re.search(r"\.eq\(\s*['\"]coop_id['\"]", chain): continue
                pre = src[max(0, s - 160):s].replace('\n', ' ')
                am = re.search(r"(?:const|let)\s*\{\s*data(?:\s*:\s*(\w+))?[^}]*\}\s*=\s*(?:await\s*)?\w*$", pre)
                var = (am.group(1) or 'data') if am else None
                ln = src[:s].count('\n') + 1; window = lines[ln:ln + 25]; use = 'list'
                if var:
                    v = re.escape(var)
                    if any(re.search(r"\b" + v + r"\b.*\.reduce\(", w) for w in window): use = 'SUM'
                    elif any(re.search(r"for\s*\(\s*(const|let)\s+\w+\s+of\s+\(?" + v + r"\b", w) for w in window): use = 'LOOP'
                    elif any(re.search(r"\b" + v + r"\)?\.length\b", w) and not re.search(r"if\s*\(|===?\s*0|>\s*0|\?|&&|\|\|", w) for w in window): use = 'COUNT'
                scope = 'society' if re.search(r"\.eq\(\s*['\"]coop_id['\"]", chain) else 'platform'
                out.append(dict(file=rel, table=table, line=ln, use=use, scope=scope))
    return out

def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--root', default=os.path.join(here, '..', 'backend'))
    ap.add_argument('--baseline', default=os.path.join(here, 'unbounded_queries.baseline.json'))
    ap.add_argument('--write-baseline', action='store_true'); ap.add_argument('--report', action='store_true')
    a = ap.parse_args()
    found = scan(a.root)
    counts = Counter(f"{f['file']}|{f['table']}" for f in found)
    if a.write_baseline:
        json.dump(dict(sorted(counts.items())), open(a.baseline, 'w'), indent=1); print(f"baseline written: {sum(counts.values())} known unbounded reads across {len(counts)} file/table pairs"); return 0
    if a.report:
        risk = {'SUM': 0, 'COUNT': 1, 'LOOP': 2, 'list': 3}
        for f in sorted(found, key=lambda f: (risk[f['use']], f['scope'], f['file'])): print(f"{f['use']:5} {f['scope']:9} {f['table']:32} {f['file']}:{f['line']}")
        print(f"\n{len(found)} unbounded society-wide/platform-wide reads. By kind: {dict(Counter(f['use'] for f in found))}"); return 0
    base = json.load(open(a.baseline)) if os.path.exists(a.baseline) else {}
    worse = {k: (counts[k], base.get(k, 0)) for k in counts if counts[k] > base.get(k, 0)}
    if not worse: print(f"OK: no new unbounded queries ({sum(counts.values())} known, {sum(base.values())} in baseline)."); return 0
    print("NEW unbounded query(ies) that read a whole society's or the whole platform's rows in one request.\nPostgREST silently truncates these at 1,000 rows. Page them with fetchAllRows (see the top of this file).\n")
    for k, (n, b) in worse.items():
        print(f"  {k}: {n} now vs {b} allowed")
        for f in found:
            if f"{f['file']}|{f['table']}" == k: print(f"      line {f['line']} ({f['use']}, {f['scope']}-wide)")
    return 1

if __name__ == '__main__': sys.exit(main())
