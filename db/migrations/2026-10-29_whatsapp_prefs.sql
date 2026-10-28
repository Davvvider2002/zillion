-- WhatsApp message preferences. A society can switch the outbox off, and a member can be opted out of WhatsApp messages.
-- Events are still recorded and still reach the member's in-app feed; opted-out ones are simply marked skipped in the outbox.
ALTER TABLE coop_societies ADD COLUMN IF NOT EXISTS whatsapp_notify_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE coop_members   ADD COLUMN IF NOT EXISTS whatsapp_opt_out boolean NOT NULL DEFAULT false;
