/**
 * zillion/backend/netlify/functions/admin-coop-bundle-links.js
 *
 * Zillion Admin issues, lists and cancels the single-use sign-up links for the Micro and Starter bundles.
 *   GET                    -> recent links with their status
 *   POST {action:'create', tier, agent_referral_code?, note?}  -> a new link (valid 30 days, one society)
 *   POST {action:'revoke', id}                                 -> cancels an unused link
 * SUPER_ADMIN / OPERATIONS only. The bundle is never offered publicly; this is the only way a society gets one.
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog } = require('../../lib/auditLog');
const { cleanText } = require('../../lib/cleanText');
const { BUNDLE_TIERS, LINK_VALID_DAYS, isBundleTier, newLinkCode } = require('../../lib/coopBundles');

const SITE = process.env.COOP_SITE_URL || 'https://zillion.ng';

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok = b => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c, m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS'])) return err(403, 'SUPER_ADMIN or OPERATIONS required');
  const db = getServiceClient();
  const who = auth.payload.username || auth.payload.sub;
  const linkUrl = code => `${SITE}/coop/?bundle=${encodeURIComponent(code)}`;

  if (event.httpMethod === 'GET') {
    const { data: links, error } = await db.from('coop_bundle_links').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) return err(500, 'Could not load links');
    const agentIds = [...new Set((links || []).map(l => l.agent_id).filter(Boolean))];
    const coopIds = [...new Set((links || []).map(l => l.used_by_coop_id).filter(Boolean))];
    const [{ data: agents }, { data: coops }] = await Promise.all([
      agentIds.length ? db.from('coop_agents').select('id, name, referral_code').in('id', agentIds) : { data: [] },
      coopIds.length ? db.from('coop_societies').select('coop_id, name').in('coop_id', coopIds) : { data: [] },
    ]);
    const agentBy = Object.fromEntries((agents || []).map(a => [a.id, a])); const coopBy = Object.fromEntries((coops || []).map(c => [c.coop_id, c]));
    const now = Date.now();
    return ok({
      plans: BUNDLE_TIERS,
      links: (links || []).map(l => ({
        id: l.id, tier: l.tier, tier_label: (BUNDLE_TIERS[l.tier] || {}).label || l.tier, note: l.note, created_by: l.created_by, created_at: l.created_at, expires_at: l.expires_at,
        status: l.revoked_at ? 'cancelled' : l.used_at ? 'used' : new Date(l.expires_at).getTime() < now ? 'expired' : 'open',
        url: !l.revoked_at && !l.used_at && new Date(l.expires_at).getTime() >= now ? linkUrl(l.code) : null,
        agent: l.agent_id && agentBy[l.agent_id] ? { name: agentBy[l.agent_id].name, referral_code: agentBy[l.agent_id].referral_code } : null,
        society: l.used_by_coop_id && coopBy[l.used_by_coop_id] ? coopBy[l.used_by_coop_id].name : null,
      })),
    });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || null;

  if (body.action === 'create') {
    if (!isBundleTier(body.tier)) return err(400, 'tier must be micro_bundle or starter_bundle');
    let agentId = null;
    const ref = String(body.agent_referral_code || '').trim();
    if (ref) {
      const { data: agent } = await db.from('coop_agents').select('id, status').eq('referral_code', ref).maybeSingle();
      if (!agent) return err(400, 'No agent has that referral code');
      if (agent.status !== 'ACTIVE') return err(400, 'That agent is not active');
      agentId = agent.id;
    }
    const code = newLinkCode();
    const expires = new Date(Date.now() + LINK_VALID_DAYS * 86400000).toISOString();
    const { data: link, error } = await db.from('coop_bundle_links').insert({
      code, tier: body.tier, note: cleanText(body.note, 200) || null, agent_id: agentId, created_by: String(who), expires_at: expires,
    }).select().single();
    if (error || !link) return err(500, 'Could not create the link');
    await auditLog(db, { action: 'COOP_BUNDLE_LINK_CREATED', username: who, role: auth.payload.role, ip, resourceType: 'coop_bundle_link', resourceId: link.id, requestBody: { tier: body.tier, agent: !!agentId }, result: 'SUCCESS' });
    return ok({ success: true, id: link.id, url: linkUrl(code), expires_at: expires });
  }

  if (body.action === 'revoke') {
    if (!body.id) return err(400, 'id is required');
    const { data } = await db.from('coop_bundle_links').update({ revoked_at: new Date().toISOString() }).eq('id', body.id).is('used_at', null).is('revoked_at', null).select('id');
    if (!data || !data.length) return err(409, 'That link is already used or cancelled');
    await auditLog(db, { action: 'COOP_BUNDLE_LINK_REVOKED', username: who, role: auth.payload.role, ip, resourceType: 'coop_bundle_link', resourceId: body.id, requestBody: {}, result: 'SUCCESS' });
    return ok({ success: true });
  }
  return err(400, 'action must be create or revoke');
};
