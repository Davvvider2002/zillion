#!/usr/bin/env python3
"""
Zillion Full-System Stress Test
Runs after every build. Must pass 100% before deploying.
Usage: python3 scripts/stress_test.py
"""
import re, os
from collections import Counter

ROOT   = '/home/claude/zillion'
ERRORS = []
WARNS  = []
OKS    = {}

def E(mod, msg):  ERRORS.append(f"[{mod}] {msg}")
def W(mod, msg):  WARNS.append(f"[{mod}] {msg}")
def OK(mod, msg): OKS.setdefault(mod,[]).append(msg)

# ── HTML validator ────────────────────────────────────────────
def check_html(path, name, cfg):
    if not os.path.exists(path):
        E(name, f"FILE NOT FOUND: {path}"); return None
    c = open(path, encoding='utf-8').read()
    sz = len(c)

    # DOCTYPE / closing tag
    if not c.startswith('<!DOCTYPE html>'): E(name,"Missing <!DOCTYPE html>")
    if not c.strip().endswith('</html>'): E(name,"Does not end with </html>")

    # Script tag counts
    inline_opens  = [m.start() for m in re.finditer(r'<script>', c)]
    inline_closes = [m.start() for m in re.finditer(r'</script>', c)]
    ext           = len(re.findall(r'<script\s+src=', c))
    exp_closes    = 1 + ext

    if len(inline_opens) != 1:
        E(name, f"Expected 1 inline <script>, found {len(inline_opens)}")
    else:
        OK(name, "Exactly 1 inline script block")

    if len(inline_closes) != exp_closes:
        E(name, f"Expected {exp_closes} </script>, found {len(inline_closes)}")
    else:
        OK(name, f"Script closing tags correct")

    script_body = html_before = ''
    if inline_opens and inline_closes:
        s0 = inline_opens[0]
        s1 = inline_closes[-1]
        body_end = c.rfind('</body>')
        html_end = c.rfind('</html>')
        if not (s0 < s1 < body_end < html_end):
            E(name, f"Wrong structure order s({s0},{s1}) body({body_end}) html({html_end})")
        else:
            OK(name, "Document structure order correct")
        script_body = c[s0:s1]
        html_before = c[:s0]

        # Raw JS function blocks in HTML (not onclick= attrs)
        bad = ['async function ','function loadMerchants(','function renderMerchant',
               'function doRegister()','function showObStep(','let allMerchantsData']
        for p in bad:
            if p in html_before:
                idx = html_before.find(p)
                E(name, f"Raw JS in HTML: '{p}' at char {idx}")
        else:
            OK(name, "No raw JS blocks in HTML section")

    # Required functions
    missing_fns = [f for f in cfg.get('fns',[]) if f not in script_body]
    if missing_fns: E(name, f"Missing functions: {missing_fns}")
    else: OK(name, f"All {len(cfg.get('fns',[]))} required functions present")

    # Required API paths
    missing_api = [a for a in cfg.get('apis',[]) if a not in c]
    if missing_api: E(name, f"Missing API calls: {missing_api}")
    else: OK(name, f"All {len(cfg.get('apis',[]))} API calls present")

    # Required element IDs
    missing_ids = [i for i in cfg.get('ids',[]) if f'id="{i}"' not in c]
    if missing_ids: E(name, f"Missing element IDs: {missing_ids}")
    else: OK(name, f"All {len(cfg.get('ids',[]))} element IDs present")

    # Duplicate IDs
    all_ids = re.findall(r'id="([^"]+)"', c)
    dupes   = [k for k,v in Counter(all_ids).items() if v>1]
    if dupes: W(name, f"Duplicate IDs: {dupes}")

    # File size
    lo,hi = cfg.get('sz',(10000,500000))
    if lo < sz < hi: OK(name, f"File size {sz:,} bytes")
    else: E(name, f"File size {sz:,} outside range ({lo:,}–{hi:,})")

    return c

# ── Backend function checker ──────────────────────────────────
def check_fn(fname, patterns):
    path = f"{ROOT}/backend/netlify/functions/{fname}"
    if not os.path.exists(path):
        E('BACKEND', f"Missing: {fname}"); return
    c = open(path).read()
    if 'exports.handler' not in c:
        E('BACKEND', f"{fname}: no exports.handler")
    else:
        OK('BACKEND', f"{fname}: exports.handler ✓")
    for p in patterns:
        if p not in c:
            E('BACKEND', f"{fname}: missing '{p}'")

# ── Routes checker ────────────────────────────────────────────
def check_routes(routes):
    path = f"{ROOT}/_redirects"
    if not os.path.exists(path):
        E('ROUTES','_redirects not found'); return
    c = open(path).read()
    missing = [r for r in routes if r not in c]
    if missing: E('ROUTES', f"Missing routes: {missing}")
    else: OK('ROUTES', f"All {len(routes)} routes present")

# ── Integration checker ───────────────────────────────────────
def check_integration(frontend_path, name, api_fn_map):
    if not os.path.exists(frontend_path):
        E('INTEGRATION', f"File not found: {frontend_path}"); return
    c = open(frontend_path).read()
    for api_name, fn in api_fn_map.items():
        fn_path = f"{ROOT}/backend/netlify/functions/{fn}"
        # API calls appear as: ${API}/name  or  API+'/name'  or  /api/v1/name
        found = (api_name in c or
                 f"/{api_name}" in c or
                 f"'{api_name}'" in c or
                 f'"{api_name}"' in c)
        if not found:
            E('INTEGRATION', f"{name}: missing API call for '{api_name}'")
        elif not os.path.exists(fn_path):
            E('INTEGRATION', f"{name}: '{api_name}' → backend '{fn}' NOT FOUND")
        else:
            OK('INTEGRATION', f"{name} ↔ {fn}")

# ══════════════════════════════════════════════════════════════
# RUN TESTS
# ══════════════════════════════════════════════════════════════

print("=" * 64)
print("  ZILLION FULL SYSTEM STRESS TEST")
print("=" * 64)

# 1. WALLET
print("\n[1/7] WALLET PWA")
check_html(f"{ROOT}/wallet/index.html", "WALLET", {
    'sz': (80000, 250000),
    'fns': ['submitPhone','verifyOtp','pinKey','selectRole','completeOnboarding',
            'goTo','goBack','refreshHome','refreshVault','refreshHistory','refreshProfile',
            'sendViaWhatsApp','generateSendQR','shareSendQRWhatsApp',
            'startScanner','stopScanner','handleQRResult','confirmQRImport',
            'processZilFile','confirmImport','trySync','checkClaimParam',
            'switchSendMethod','switchRecvTab','fmtNaira','save','load'],
    'apis': ['send-otp','verify-otp','create-claim','fetch-claim'],
    'ids': ['screen-splash','screen-phone','screen-pin','screen-role',
            'screen-home','screen-vault','screen-send','screen-receive',
            'screen-history','screen-profile',
            'phone-input','otp0','home-balance','vault-total',
            'qr-video','recv-panel-qr','recv-panel-file',
            'send-panel-qr','send-panel-wa','send-qr-canvas','zil-file-input'],
})

# 2. AGENT
print("\n[2/7] AGENT PORTAL")
check_html(f"{ROOT}/agent/index.html", "AGENT", {
    'sz': (25000, 120000),
    'fns': ['doLogin','doLogout','showApp','doCashIn','doCashOut','doVerify',
            'generateQR','shareQRWhatsApp','saveQRImage','startQRCountdown',
            'loadStatement','switchTab','notify'],
    'apis': ['agent-login','issue','redeem','validate','create-claim'],
    'ids': ['loader','lbtn','lerr'],
})

# 3. MERCHANT
print("\n[3/7] MERCHANT PORTAL")
check_html(f"{ROOT}/merchant/index.html", "MERCHANT", {
    'sz': (40000, 150000),
    'fns': ['showPanel','validateStep1','validateStep2','doRegister','doLogin',
            'showApp','doLogout','goScreen','refreshHome','ensureMyQR',
            'refreshMyQR','shareMyQR','startScan','stopScan','handleScanResult',
            'confirmPayment','generateCashoutQR','refreshProfile','renderQR',
            'fmt','save','load'],
    'apis': ['merchant-register','merchant-login','create-payment-request','fetch-claim'],
    'ids': ['ob-wrap','ob-splash','ob-step1','ob-step2','ob-step3','ob-login',
            'ob-owner','ob-phone','ob-biz','ob-type','ob-loc',
            'ob-confirm-summary','ob-reg-btn','ob-err',
            'l-phone','l-biz','l-err',
            'app-shell','screen-home','screen-scan','screen-myqr',
            'screen-cashout','screen-profile',
            'scan-video','pay-result','pr-accept-btn',
            'myqr-canvas','myqr-timer','co-qr-canvas','cashout-qr-box'],
})

# 4. ADMIN
print("\n[4/7] ADMIN DASHBOARD")
check_html(f"{ROOT}/admin/index.html", "ADMIN", {
    'sz': (50000, 200000),
    'fns': ['doLogin','doLogout','showApp','showSec',
            'loadOverview','loadUsers','loadMerchants','loadAgents',
            'loadCoins','loadTransactions','loadFraud','checkSystem',
            'filterMerchantTable','renderMerchantCards','renderMerchantTable',
            'exportMerchants','suspendMerchant','showMerchantEmpty',
            'filterUserTable','renderUserTable','exportUsers',
            'generateToken','renderTokHistory','lookupCoin',
            'downloadCSV','notify','showLoader','hideLoader',
            'fmt','fmtDate','relTime','setText','statusBadge'],
    'apis': ['admin-login','admin-agents','admin-users','admin-merchants',
             'admin-coins','admin-transactions','agent-token','validate'],
    'ids': ['login-screen','app-screen',
            'sec-overview','sec-customers','sec-merchants','sec-agents',
            'sec-coins','sec-transactions','sec-tokens','sec-fraud','sec-system',
            'merchant-cards-grid','merchant-table-body',
            'merch-m-total','merch-m-active','merch-m-payments','merch-m-volume',
            'merch-search','merch-status-filter','merch-type-filter',
            'm-users','m-float','m-merchants',
            'user-table-body','agent-table-body','coin-table-body','tx-table-body',
            'tok-val','tok-out','genbtn'],
})

# 5. BACKEND FUNCTIONS
print("\n[5/7] BACKEND FUNCTIONS")
check_fn('issue.js',                  ['exports.handler','issueCoinBatch'])
check_fn('sync.js',                   ['exports.handler','processSyncBatch'])
check_fn('redeem.js',                 ['exports.handler','redeemCoins'])
check_fn('validate.js',               ['exports.handler'])
check_fn('agent-login.js',            ['exports.handler'])
check_fn('agent-token.js',            ['exports.handler'])
check_fn('agent-statement.js',        ['exports.handler'])
check_fn('admin-login.js',            ['exports.handler'])
check_fn('admin-agents.js',           ['exports.handler'])
check_fn('admin-users.js',            ['exports.handler'])
check_fn('admin-coins.js',            ['exports.handler'])
check_fn('admin-transactions.js',     ['exports.handler'])
check_fn('admin-merchants.js',        ['exports.handler','merchants'])
check_fn('merchant-login.js',         ['exports.handler'])
check_fn('merchant-register.js',      ['exports.handler','merchant_id'])
check_fn('send-otp.js',               ['exports.handler','generateOtp'])
check_fn('verify-otp.js',             ['exports.handler','hashOtp'])
check_fn('create-claim.js',           ['exports.handler','claim_bundles'])
check_fn('fetch-claim.js',            ['exports.handler','CLAIMED'])
check_fn('create-payment-request.js', ['exports.handler'])

# 6. ROUTES
print("\n[6/7] ROUTES")
check_routes([
    '/wallet','/wallet/','/merchant','/merchant/',
    '/agent','/agent/','/admin','/admin/',
    '/api/v1/issue','/api/v1/sync','/api/v1/redeem','/api/v1/validate',
    '/api/v1/agent-login','/api/v1/agent-token','/api/v1/agent-statement',
    '/api/v1/admin-login','/api/v1/admin-agents','/api/v1/admin-users',
    '/api/v1/admin-coins','/api/v1/admin-transactions','/api/v1/admin-merchants',
    '/api/v1/send-otp','/api/v1/verify-otp',
    '/api/v1/create-claim','/api/v1/fetch-claim',
    '/api/v1/create-payment-request',
    '/api/v1/merchant-login','/api/v1/merchant-register',
])

# 7. INTEGRATION
print("\n[7/7] CROSS-MODULE INTEGRATION")
check_integration(f"{ROOT}/wallet/index.html", "wallet", {
    'send-otp':        'send-otp.js',
    'verify-otp':      'verify-otp.js',
    'create-claim':    'create-claim.js',
    'fetch-claim':     'fetch-claim.js',
})
check_integration(f"{ROOT}/agent/index.html", "agent", {
    'agent-login':     'agent-login.js',
    'issue':           'issue.js',
    'create-claim':    'create-claim.js',
})
check_integration(f"{ROOT}/merchant/index.html", "merchant", {
    'merchant-register':      'merchant-register.js',
    'merchant-login':         'merchant-login.js',
    'create-payment-request': 'create-payment-request.js',
    'fetch-claim':            'fetch-claim.js',
})
check_integration(f"{ROOT}/admin/index.html", "admin", {
    'admin-login':        'admin-login.js',
    'admin-agents':       'admin-agents.js',
    'admin-users':        'admin-users.js',
    'admin-merchants':    'admin-merchants.js',
    'admin-coins':        'admin-coins.js',
    'admin-transactions': 'admin-transactions.js',
    'agent-token':        'agent-token.js',
})

# QR system consistency
for fname, token in [('create-claim.js','claim_bundles'),('fetch-claim.js','CLAIMED')]:
    p = f"{ROOT}/backend/netlify/functions/{fname}"
    if os.path.exists(p) and token in open(p).read():
        OK('QR_SYSTEM', f"{fname} has '{token}'")
    else:
        E('QR_SYSTEM', f"{fname} missing '{token}'")

# ══════════════════════════════════════════════════════════════
# FINAL REPORT
# ══════════════════════════════════════════════════════════════
total_ok  = sum(len(v) for v in OKS.values())
total_err = len(ERRORS)
total_warn= len(WARNS)

print("\n" + "=" * 64)
print("  RESULTS")
print("=" * 64)
if ERRORS:
    print(f"\n❌ ERRORS ({total_err}):")
    for e in ERRORS: print(f"  {e}")
if WARNS:
    print(f"\n⚠️  WARNINGS ({total_warn}):")
    for w in WARNS: print(f"  {w}")

print(f"\n  ✅ Passed: {total_ok}  ❌ Errors: {total_err}  ⚠️  Warnings: {total_warn}")
print()
if total_err == 0:
    print("  🟢 ALL TESTS PASSED — SAFE TO DEPLOY")
else:
    print("  🔴 FIX ERRORS BEFORE DEPLOYING")
print("=" * 64)

import sys
sys.exit(0 if total_err == 0 else 1)
