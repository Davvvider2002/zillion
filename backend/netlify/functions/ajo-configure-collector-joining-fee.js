/**
 * zillion/backend/netlify/functions/ajo-configure-collector-joining-fee.js
 *
 * POST /api/v1/ajo-configure-collector-joining-fee
 *
 * DEPRECATED as of the collector-recruitment correction: collectors work for Zillion Ajo platform-wide, not
 * for whichever Ajo admin happened to recruit them. There is exactly one joining fee, set by Zillion Admin
 * via admin-ajo-collector-platform-fee.js, not one per individual Ajo admin's own self-service setting.
 *
 * Deliberately NOT deleted outright - anything still calling this (an old cached frontend build, a stray
 * integration) gets a meaningful error explaining what changed, not a broken request. Matches the same
 * treatment ajo-admin-manage-collector.js got for the earlier agent/collector role-merge correction.
 */
'use strict';

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const err = (c,m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });

  return err(410, "There's no longer a per-admin collector joining fee - collectors work for Zillion Ajo platform-wide, and Zillion Admin sets the one fee everyone pays. See admin-ajo-collector-platform-fee.js.");
};
