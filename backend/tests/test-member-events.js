/** Member event log: message text, wa.me links, dedupe, go-live exclusion, and that it never throws. Run: node backend/tests/test-member-events.js */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, '..', 'lib', 'coopMemberEvents'));
const { fakeDb } = require('./helpers/goLiveFakeDb');
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

(async () => {
  ok('naira formatting', E.naira(500000) === '₦5,000' && E.naira(123450) === '₦1,234.50');
  const m = E.buildMessage('savings_deposit', { societyName: 'Unity Coop', memberName: 'Ada Okafor', amountKobo: 500000, balanceKobo: 4200000, reference: 'R-77', date: '2026-10-28T10:00:00Z' });
  ok('deposit message reads naturally', m === 'Hello Ada, Unity Coop: ₦5,000 savings deposit received on 28 Oct 2026. Balance ₦42,000. Ref: R-77.');
  ok('no dash phrases in any template', Object.keys(E.KINDS).every(k => !/[—–]/.test(E.buildMessage(k, { societyName: 'S', memberName: 'A B', amountKobo: 100, note: 'x' }))));
  ok('withdrawals carry the check-with-the-office line', /Contact the office/.test(E.buildMessage('savings_withdrawal', { amountKobo: 100 })));
  ok('wa.me link from local, plus and 234 forms', ['08031234567', '+2348031234567', '2348031234567', '8031234567'].every(p => E.waPhone(p) === '2348031234567'));
  ok('the link opens the chat with the text encoded', E.whatsappUrl('08031234567', 'Hi & bye') === 'https://wa.me/2348031234567?text=Hi%20%26%20bye' && E.whatsappUrl('', 'x') === null);

  const db = fakeDb({
    coop_societies: [{ coop_id: 'C1', name: 'Unity Coop' }],
    coop_members: [{ id: 'm1', coop_id: 'C1', name: 'Ada Okafor', phone_normalized: '+2348031234567' }],
    coop_member_events: [], coop_notifications: [],
  });
  const r = await E.recordMemberEvent(db, { coopId: 'C1', memberId: 'm1', kind: 'dues_paid', amountKobo: 100000, refId: 'tx1', actor: 'portal:9' });
  const t = db.t();
  ok('an event row is written with the message and the phone', r.recorded && t.coop_member_events.length === 1 && /dues payment received/.test(t.coop_member_events[0].message) && t.coop_member_events[0].member_phone === '+2348031234567' && t.coop_member_events[0].whatsapp_status === undefined);
  ok('the member gets an in-app notification and the event links to it', t.coop_notifications.length === 1 && t.coop_notifications[0].target_member_id === 'm1' && t.coop_member_events[0].notification_id === t.coop_notifications[0].id);
  const skipped = await E.recordMemberEvent(db, { coopId: 'C1', memberId: 'm1', kind: 'dues_paid', amountKobo: 1, skip: true });
  ok('go-live rows never produce an event', !skipped.recorded && t.coop_member_events.length === 1);
  const bogus = await E.recordMemberEvent(db, { coopId: 'C1', memberId: 'nobody', kind: 'dues_paid', amountKobo: 1 });
  ok('an unknown member is ignored quietly', !bogus.recorded && bogus.reason === 'member_not_found');
  ok('an unknown kind is ignored quietly', (await E.recordMemberEvent(db, { coopId: 'C1', memberId: 'm1', kind: 'nope' })).reason === 'unknown_kind');
  const broken = await E.recordMemberEvent({ from() { throw new Error('db down'); } }, { coopId: 'C1', memberId: 'm1', kind: 'dues_paid', amountKobo: 1 });
  ok('a database failure never throws into the caller', broken.recorded === false);
  const FN = path.join(__dirname, '..', 'netlify', 'functions');
  const h = require(path.join(FN, 'coop-portal-whatsapp-outbox')).handler;
  ok('outbox endpoint refuses no token with 401', (await h({ httpMethod: 'POST', headers: {}, body: '{}' })).statusCode === 401);
  ok('outbox endpoint refuses GET with 405', (await h({ httpMethod: 'GET', headers: {} })).statusCode === 405);
  ok('outbox endpoint is routed', require('fs').readFileSync(path.join(__dirname, '..', '..', 'netlify.toml'), 'utf8').includes('from = "/api/v1/coop-portal-whatsapp-outbox"'));
  console.log(bad ? `\n${bad} FAILED` : '\nAll member event tests passed');
})();
