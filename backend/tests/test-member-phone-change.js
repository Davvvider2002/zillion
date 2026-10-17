/**
 * zillion/backend/tests/test-member-phone-change.js
 * Member wallet number change: staff create a one time link, the member submits the new number (proved by a text code),
 * staff approve, reject or ask for more proof. Approval moves the identity, every society membership and the wallet device
 * hash, leaves coins alone, and undoes everything if a step fails.
 * Run: node backend/tests/test-member-phone-change.js
 */
'use strict';
const path = require('path'); const { createHmac, createHash } = require('crypto');
const LIB = path.join(__dirname, '..', 'lib'); const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');
process.env.JWT_SECRET = 'test-secret'; process.env.OTP_SECRET = 'otp-secret'; process.env.SUPABASE_SERVICE_KEY = 'svc-key'; process.env.PUBLIC_SITE_URL = 'https://zillion.test';
let currentDb = null; let audits = []; let staffRole = 'SUPER_ADMIN'; let limited = false;
const stub = (mod, exports) => { require.cache[require.resolve(path.join(LIB, mod))] = { id: mod, filename: mod, loaded: true, exports }; };
stub('supabase', { getServiceClient: () => currentDb });
stub('auditLog', { auditLog: async (db, e) => { audits.push(e); } });
stub('publicRateLimit', { limitByKey: async () => limited ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true }, limitByIp: async () => limited ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true }, tooManyRequests: () => ({ statusCode: 429, body: '{}' }) });
const validators = require(path.join(LIB, 'validators'));
validators.verifyJWT = h => h === 'Bearer staff' ? { valid: true, payload: { role: staffRole, username: 'david' } } : { valid: false, reason: 'no' };
const admin = require(path.join(FN, 'admin-member-phone-change')).handler;
const pub = require(path.join(FN, 'member-phone-change')).handler;
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const hm = p => createHmac('sha256', 'svc-key').update(p).digest('hex');
const OLD = '+2348011111111', NEW = '+2348055555555', OTHER = '+2348022222222';

const mk = () => {
  const db = makeDb({
    coop_societies: [{ coop_id: 'COOP-1', name: 'Alpha Coop' }, { coop_id: 'COOP-2', name: 'Beta Coop' }],
    coop_members: [
      { id: 'm1', coop_id: 'COOP-1', zillion_id: 'Z1', phone_normalized: OLD, name: 'Ada Obi', member_number: 'A-001', status: 'ACTIVE' },
      { id: 'm1b', coop_id: 'COOP-2', zillion_id: 'Z1', phone_normalized: OLD, name: 'Ada Obi', member_number: 'B-007', status: 'ACTIVE' },
      { id: 'm2', coop_id: 'COOP-1', zillion_id: 'Z2', phone_normalized: OTHER, name: 'Bayo Ade', member_number: 'A-002', status: 'ACTIVE' },
    ],
    zillion_identities: [{ zillion_id: 'Z1', phone_normalized: OLD }, { zillion_id: 'Z2', phone_normalized: OTHER }],
    devices: [
      { device_hash: 'd1', phone_hash: hm(OLD), phone_number: OLD, zillion_id: 'Z1', holder_hash: 'H1', public_key_hex: 'KEY' },
      { device_hash: 'd2', phone_hash: hm(OTHER), zillion_id: 'Z2', holder_hash: 'H2', public_key_hex: 'KEY' },
    ],
    coins: [{ coin_id: 'c1', holder_hash: 'H1', amount: 5000, status: 'HELD' }, { coin_id: 'c2', holder_hash: createHash('sha256').update(OLD).digest('hex'), amount: 2500, status: 'HELD' }],
    merchants: [], agents: [], coop_portal_users: [], otp_requests: [], coop_member_phone_change_requests: [],
  });
  const files = [];
  db.storage = { from: () => ({ upload: async (p) => { files.push(p); return { error: null }; }, createSignedUrl: async (p) => ({ data: { signedUrl: 'https://files.test/' + p } }) }) };
  db.files = files;
  return db;
};
const seedOtp = (db, phone, code, extra = {}) => db.tables.otp_requests.push({ id: 'o' + (db.tables.otp_requests.length + 1), phone, hashed_otp: createHmac('sha256', 'otp-secret').update(`${code}:${phone}`).digest('hex'), expires_at: new Date(Date.now() + 600000).toISOString(), attempts: 0, used: false, created_at: new Date().toISOString(), ...extra });
const A = async (body, token) => { const r = await admin({ httpMethod: 'POST', headers: { authorization: token === undefined ? 'Bearer staff' : token }, body: JSON.stringify(body) }); return { s: r.statusCode, b: JSON.parse(r.body || '{}') }; };
const AG = async (qs, token) => { const r = await admin({ httpMethod: 'GET', headers: { authorization: token === undefined ? 'Bearer staff' : token }, queryStringParameters: qs }); return { s: r.statusCode, b: JSON.parse(r.body || '{}') }; };
const P = async (body) => { const r = await pub({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) }); return { s: r.statusCode, b: JSON.parse(r.body || '{}') }; };
const PG = async (t) => { const r = await pub({ httpMethod: 'GET', headers: {}, queryStringParameters: { t } }); return { s: r.statusCode, b: JSON.parse(r.body || '{}') }; };
const tokenOf = link => decodeURIComponent(link.split('t=')[1]);
const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const row = (db, id) => db.tables.coop_member_phone_change_requests.find(r => r.id === id);

// Takes a member from nothing to SUBMITTED. Returns { id, token }.
async function toSubmitted(db, memberId, newPhone = NEW, code = '123456') {
  const c = await A({ action: 'create_link', member_id: memberId });
  const token = tokenOf(c.b.link);
  await P({ t: token, action: 'upload', file_name: 'police.png', mime_type: 'image/png', file_base64: png });
  seedOtp(db, newPhone, code);
  const s = await P({ t: token, action: 'submit', new_phone: newPhone, otp: code, reason: 'Lost my SIM card' });
  return { id: c.b.id, token, submit: s };
}

(async () => {
  // ── Access and link creation ──
  currentDb = mk();
  let r = await A({ action: 'create_link', member_id: 'm1' }, null); ok('no staff login is refused', r.s === 401);
  staffRole = 'SUPPORT'; r = await A({ action: 'create_link', member_id: 'm1' }); ok('a read only role cannot create links', r.s === 403);
  r = await AG({ action: 'list' }); ok('a read only role can read the queue', r.s === 200); staffRole = 'SUPER_ADMIN';
  r = await A({ action: 'create_link', member_id: 'nope' }); ok('unknown member is 404', r.s === 404);
  limited = true; r = await A({ action: 'create_link', member_id: 'm1' }); limited = false; ok('staff actions are rate limited', r.s === 429);

  r = await A({ action: 'create_link', member_id: 'm1', note: 'Member called in' });
  ok('staff can create a link', r.s === 200 && r.b.link.startsWith('https://zillion.test/member-number-change/?t='));
  const tok = tokenOf(r.b.link); const id1 = r.b.id;
  ok('only a hash of the token is stored', !JSON.stringify(currentDb.tables.coop_member_phone_change_requests).includes(tok) && row(currentDb, id1).token_hash.length === 64);
  ok('link creation is audit logged', audits.some(a => a.action === 'MEMBER_PHONE_CHANGE_LINK_CREATED' && a.resourceId === id1));
  r = await A({ action: 'create_link', member_id: 'm1' }); ok('a second open request for the same member is refused', r.s === 409);

  // ── Public page ──
  r = await PG('x'.repeat(43)); ok('an unknown token is 404', r.s === 404);
  r = await PG(''); ok('a missing token is 404', r.s === 404);
  r = await PG(tok);
  ok('the page shows state and society', r.s === 200 && r.b.state === 'LINK_SENT' && r.b.society === 'Alpha Coop' && r.b.member_name === 'Ada Obi');
  ok('the old number is masked', !JSON.stringify(r.b).includes('8011111111') && r.b.old_phone_masked.endsWith('111'));
  limited = true; r = await PG(tok); limited = false; ok('the public page is rate limited', r.s === 429);

  // ── Upload ──
  r = await P({ t: tok, action: 'upload', file_name: 'x.exe', mime_type: 'application/x-msdownload', file_base64: png }); ok('a bad file type is refused', r.s === 400);
  r = await P({ t: tok, action: 'upload', file_name: 'big.png', mime_type: 'image/png', file_base64: Buffer.alloc(4 * 1024 * 1024 + 10).toString('base64') }); ok('an oversize file is refused', r.s === 400);
  r = await P({ t: tok, action: 'upload', file_name: 'police.png', mime_type: 'image/png', file_base64: png });
  ok('a proof file is stored privately and recorded', r.s === 200 && currentDb.files.length === 1 && currentDb.files[0].startsWith(id1 + '/') && row(currentDb, id1).proof.length === 1);
  for (let i = 0; i < 5; i++) await P({ t: tok, action: 'upload', file_name: `f${i}.png`, mime_type: 'image/png', file_base64: png });
  r = await P({ t: tok, action: 'upload', file_name: 'seventh.png', mime_type: 'image/png', file_base64: png }); ok('no more than 6 files', r.s === 400 && row(currentDb, id1).proof.length === 6);

  // ── Submit rules ──
  r = await P({ t: tok, action: 'submit', new_phone: NEW, otp: '123456', reason: 'Lost my SIM card' }); ok('no code sent means no submit', r.s === 400 && row(currentDb, id1).status === 'LINK_SENT');
  seedOtp(currentDb, NEW, '123456');
  r = await P({ t: tok, action: 'submit', new_phone: NEW, otp: '654321', reason: 'Lost my SIM card' });
  ok('a wrong code is refused and counted', r.s === 400 && currentDb.tables.otp_requests[0].attempts === 1 && row(currentDb, id1).status === 'LINK_SENT');
  { const o = currentDb.tables.otp_requests[0]; const keep = o.attempts; o.attempts = 5;
    r = await P({ t: tok, action: 'submit', new_phone: NEW, otp: '123456', reason: 'Lost my SIM card' }); o.attempts = keep;
    ok('a code that has used its 5 attempts is refused even when right', r.s === 400 && row(currentDb, id1).status === 'LINK_SENT');
    const exp = o.expires_at; o.expires_at = new Date(Date.now() - 1000).toISOString();
    r = await P({ t: tok, action: 'submit', new_phone: NEW, otp: '123456', reason: 'Lost my SIM card' }); o.expires_at = exp;
    ok('an expired code is refused', r.s === 400 && row(currentDb, id1).status === 'LINK_SENT'); }
  r = await P({ t: tok, action: 'submit', new_phone: NEW, otp: '123456', reason: 'abc' }); ok('a reason is required', r.s === 400);
  r = await P({ t: tok, action: 'submit', new_phone: '08011111111', otp: '123456', reason: 'Lost my SIM card' }); ok('the same number is refused', r.s === 400);
  r = await P({ t: tok, action: 'submit', new_phone: '123', otp: '123456', reason: 'Lost my SIM card' }); ok('a malformed number is refused', r.s === 400);
  r = await P({ t: tok, action: 'submit', new_phone: OTHER, otp: '123456', reason: 'Lost my SIM card' }); ok('a number that belongs to another member is refused', r.s === 409 && row(currentDb, id1).status === 'LINK_SENT');
  r = await P({ t: tok, action: 'submit', new_phone: NEW, otp: '123456', reason: 'Lost my SIM card' });
  ok('a correct code submits the request', r.s === 200 && row(currentDb, id1).status === 'SUBMITTED' && row(currentDb, id1).new_phone === NEW && !!row(currentDb, id1).otp_verified_at);
  ok('the code can only be used once', currentDb.tables.otp_requests[0].used === true);
  ok('nothing on the member account changed yet', currentDb.tables.coop_members[0].phone_normalized === OLD && currentDb.tables.zillion_identities[0].phone_normalized === OLD);
  r = await P({ t: tok, action: 'submit', new_phone: NEW, otp: '123456', reason: 'Lost my SIM card' }); ok('submitting twice is refused', r.s === 409);
  r = await P({ t: tok, action: 'upload', file_name: 'late.png', mime_type: 'image/png', file_base64: png }); ok('no uploads while under review', r.s === 409);
  r = await PG(tok); ok('the page now says under review', r.b.state === 'SUBMITTED');

  // ── Admin review ──
  r = await AG({ action: 'list', status: 'SUBMITTED' }); ok('the queue lists it', r.s === 200 && r.b.requests.length === 1 && r.b.requests[0].society === 'Alpha Coop' && r.b.requests[0].proof_count === 6);
  r = await AG({ action: 'detail', id: id1 });
  ok('detail has proof links, no token hash', r.s === 200 && r.b.request.proof.length === 6 && r.b.request.proof[0].url.startsWith('https://files.test/') && !('token_hash' in r.b.request));
  ok('impact lists both societies', r.b.impact.societies.length === 2 && r.b.impact.warnings.some(w => /2 societies/.test(w)));
  ok('impact reports the coins held and says they are not moved', r.b.impact.held_coins === 2 && r.b.impact.held_kobo === 7500 && r.b.impact.warnings.some(w => /not moved/.test(w)));

  r = await A({ action: 'decide', id: id1, decision: 'more_proof', note: '' }); ok('asking for proof needs a note', r.s === 400);
  r = await A({ action: 'decide', id: id1, decision: 'reject', note: '' }); ok('rejecting needs a reason', r.s === 400);
  staffRole = 'SUPPORT'; r = await A({ action: 'decide', id: id1, decision: 'approve' }); ok('a read only role cannot decide', r.s === 403); staffRole = 'SUPER_ADMIN';

  currentDb.tables.coop_member_phone_change_requests[0].expires_at = new Date(Date.now() + 3600000).toISOString();
  r = await A({ action: 'decide', id: id1, decision: 'more_proof', note: 'Attach the SIM replacement slip' });
  ok('ask for more proof', r.s === 200 && row(currentDb, id1).status === 'MORE_PROOF_REQUESTED' && new Date(row(currentDb, id1).expires_at) > new Date(Date.now() + 5 * 24 * 3600 * 1000));
  r = await PG(tok); ok('the member sees what is needed and the same link works', r.b.state === 'MORE_PROOF_REQUESTED' && r.b.staff_note === 'Attach the SIM replacement slip');
  r = await P({ t: tok, action: 'submit', new_phone: NEW, reason: 'Lost my SIM card' }); ok('resubmitting without new proof is refused', r.s === 400 && row(currentDb, id1).status === 'MORE_PROOF_REQUESTED');
  await new Promise(res => setTimeout(res, 5));
  currentDb.files.length = 0;
  r = await P({ t: tok, action: 'upload', file_name: 'slip.png', mime_type: 'image/png', file_base64: png }); ok('the member can add proof', r.s === 400 /* already 6 */);
  row(currentDb, id1).proof.pop();
  r = await P({ t: tok, action: 'upload', file_name: 'slip.png', mime_type: 'image/png', file_base64: png });
  r = await P({ t: tok, action: 'submit', new_phone: NEW, reason: 'Lost my SIM card' });
  ok('with new proof the same verified number goes back without a second code', r.s === 200 && row(currentDb, id1).status === 'SUBMITTED');
  r = await A({ action: 'decide', id: id1, decision: 'more_proof', note: 'One more please' });
  await new Promise(res => setTimeout(res, 5));
  row(currentDb, id1).proof.pop(); await P({ t: tok, action: 'upload', file_name: 'again.png', mime_type: 'image/png', file_base64: png });
  r = await P({ t: tok, action: 'submit', new_phone: '08077777777', reason: 'Lost my SIM card' });
  ok('changing the number in a later round needs a fresh code', r.s === 400 && row(currentDb, id1).status === 'MORE_PROOF_REQUESTED');
  r = await P({ t: tok, action: 'submit', new_phone: NEW, reason: 'Lost my SIM card' }); ok('back to the verified number goes through', r.s === 200);

  // ── Approval ──
  { const rw = row(currentDb, id1), keep = rw.otp_verified_at; rw.otp_verified_at = null;
    r = await A({ action: 'decide', id: id1, decision: 'approve' }); rw.otp_verified_at = keep;
    ok('a request whose number was never proven cannot be approved', r.s === 409 && rw.status === 'SUBMITTED' && currentDb.tables.coop_members[0].phone_normalized === OLD); }
  r = await A({ action: 'decide', id: id1, decision: 'approve' });
  const db = currentDb;
  ok('approve succeeds', r.s === 200 && r.b.status === 'APPROVED' && row(db, id1).status === 'APPROVED' && row(db, id1).decided_by === 'david');
  ok('the identity moved to the new number', db.tables.zillion_identities[0].phone_normalized === NEW && db.tables.zillion_identities[0].zillion_id === 'Z1');
  ok('every society membership for that person moved', db.tables.coop_members[0].phone_normalized === NEW && db.tables.coop_members[1].phone_normalized === NEW);
  ok('other members are untouched', db.tables.coop_members[2].phone_normalized === OTHER && db.tables.zillion_identities[1].phone_normalized === OTHER && db.tables.devices[1].phone_hash === hm(OTHER));
  ok('the wallet device follows the new number so recovery finds the coins', db.tables.devices[0].phone_hash === hm(NEW) && db.tables.devices[0].phone_number === NEW && db.tables.devices[0].holder_hash === 'H1');
  ok('coins are not touched', db.tables.coins.every(c => c.status === 'HELD') && db.tables.coins[0].holder_hash === 'H1');
  ok('what changed is recorded for reversal', row(db, id1).applied_changes.members.length === 2 && row(db, id1).applied_changes.devices[0].phone_hash_from === hm(OLD) && row(db, id1).applied_changes.identity.from === OLD);
  ok('approval is audit logged', audits.some(a => a.action === 'MEMBER_PHONE_CHANGE_APPROVED' && a.result === 'SUCCESS' && a.requestBody.new_phone === NEW));
  r = await A({ action: 'decide', id: id1, decision: 'approve' }); ok('approving twice is refused', r.s === 409);
  r = await PG(tok); ok('the member page says approved', r.b.state === 'APPROVED');
  r = await P({ t: tok, action: 'submit', new_phone: NEW, otp: '1', reason: 'again again' }); ok('a used link no longer accepts submissions', r.s === 409);

  // ── Reject ──
  let q = await toSubmitted(db, 'm2', '+2348066666666', '222222');
  ok('second member submitted', q.submit.s === 200);
  r = await A({ action: 'decide', id: q.id, decision: 'reject', note: 'Documents do not match the name' });
  ok('reject records the reason and changes nothing', r.s === 200 && row(db, q.id).status === 'REJECTED' && db.tables.coop_members[2].phone_normalized === OTHER && row(db, q.id).applied_changes == null);
  r = await PG(q.token); ok('the member sees the rejection reason', r.b.state === 'REJECTED' && /do not match/.test(r.b.staff_note));
  r = await P({ t: q.token, action: 'submit', new_phone: '+2348066666666', otp: '222222', reason: 'try again please' }); ok('a rejected link is closed', r.s === 409);

  // ── Approval refused: number taken in the meantime ──
  q = await toSubmitted(db, 'm2', '+2348066666666', '333333');
  db.tables.coop_members.push({ id: 'm9', coop_id: 'COOP-2', zillion_id: 'Z9', phone_normalized: '+2348066666666', name: 'Someone', status: 'ACTIVE' });
  r = await A({ action: 'decide', id: q.id, decision: 'approve' });
  ok('approval is refused if the number was taken meanwhile', r.s === 409 && row(db, q.id).status === 'SUBMITTED' && db.tables.coop_members[2].phone_normalized === OTHER);
  db.tables.coop_members.pop();

  // ── Failure part way through rolls back ──
  const realFrom = db.from.bind(db);
  db.from = t => { const x = realFrom(t); if (t === 'devices') x.update = () => ({ eq: () => ({ then: res => res({ data: null, error: { message: 'boom' } }) }) }); return x; };
  r = await A({ action: 'decide', id: q.id, decision: 'approve' });
  db.from = realFrom;
  ok('a failed step refuses the approval', r.s === 409 && /device/i.test(r.b.error));
  ok('and puts everything back', db.tables.coop_members[2].phone_normalized === OTHER && db.tables.zillion_identities[1].phone_normalized === OTHER && row(db, q.id).status === 'SUBMITTED' && row(db, q.id).applied_changes == null);
  ok('the failure is audit logged', audits.some(a => a.action === 'MEMBER_PHONE_CHANGE_APPROVED' && a.result === 'FAILURE'));
  r = await A({ action: 'decide', id: q.id, decision: 'approve' });
  ok('and the same request can be approved afterwards', r.s === 200 && db.tables.coop_members[2].phone_normalized === '+2348066666666' && db.tables.zillion_identities[1].phone_normalized === '+2348066666666');

  // ── A leftover identity row for the new number is cleared ──
  const db2 = mk(); currentDb = db2;
  db2.tables.zillion_identities.push({ zillion_id: 'ZSTALE', phone_normalized: NEW });
  q = await toSubmitted(db2, 'm1'); r = await A({ action: 'decide', id: q.id, decision: 'approve' });
  ok('an unused identity on the new number does not block approval', r.s === 200 && !db2.tables.zillion_identities.some(i => i.zillion_id === 'ZSTALE') && db2.tables.zillion_identities.find(i => i.zillion_id === 'Z1').phone_normalized === NEW);
  const db3 = mk(); currentDb = db3;
  db3.tables.zillion_identities.push({ zillion_id: 'ZWALLET', phone_normalized: NEW }); db3.tables.devices.push({ device_hash: 'dw', zillion_id: 'ZWALLET', phone_hash: 'other-hash', public_key_hex: 'KEY' });
  q = await toSubmitted(db3, 'm1');
  ok('a number that already has a wallet is refused at submit', q.submit.s === 409);

  // ── Cancel, reissue, expiry, search ──
  const db4 = mk(); currentDb = db4;
  let c = await A({ action: 'create_link', member_id: 'm1' }); const old = tokenOf(c.b.link);
  let ri = await A({ action: 'reissue_link', id: c.b.id }); const fresh = tokenOf(ri.b.link);
  ok('reissue gives a new link and kills the old one', ri.s === 200 && fresh !== old && (await PG(old)).s === 404 && (await PG(fresh)).s === 200);
  row(db4, c.b.id).expires_at = new Date(Date.now() - 1000).toISOString();
  r = await PG(fresh); ok('an expired link shows as expired', r.b.state === 'EXPIRED');
  r = await P({ t: fresh, action: 'upload', file_name: 'a.png', mime_type: 'image/png', file_base64: png }); ok('an expired link accepts nothing', r.s === 410);
  r = await A({ action: 'cancel', id: c.b.id }); ok('staff can cancel an open request', r.s === 200 && row(db4, c.b.id).status === 'CANCELLED');
  r = await A({ action: 'cancel', id: c.b.id }); ok('a closed request cannot be cancelled again', r.s === 409);
  r = await A({ action: 'create_link', member_id: 'm1' }); ok('a new link can be made after cancelling', r.s === 200);

  r = await AG({ action: 'members', q: 'ada' }); ok('search by name', r.s === 200 && r.b.members.length === 2 && r.b.members[0].society);
  r = await AG({ action: 'members', q: '08022222222' }); ok('search by number', r.b.members.length === 1 && r.b.members[0].id === 'm2');
  r = await AG({ action: 'members', q: 'A-002' }); ok('search by member number', r.b.members.length === 1 && r.b.members[0].id === 'm2');
  r = await AG({ action: 'members', q: 'a' }); ok('search needs 2 characters', r.s === 400);
  r = await AG({ action: 'members', q: 'ada' }); ok('search flags a member with an open request', r.b.members.find(m => m.id === 'm1').open_request === 'LINK_SENT');

  console.log(bad ? `\n${bad} FAILED` : '\nAll member number change checks passed');
})().catch(e => { console.error(e); process.exit(1); });
