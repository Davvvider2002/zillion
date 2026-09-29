-- Referral codes are no longer typed in by an admin — generateReferralCode() (lib/coopAgentHierarchy.js)
-- derives them from the agent's name, so the name itself needs somewhere to live on the row (it wasn't
-- stored before; only baked into whatever code an admin happened to type).
ALTER TABLE coop_agents ADD COLUMN IF NOT EXISTS name text;
