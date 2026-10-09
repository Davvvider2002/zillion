-- Give the Investment add-on a description (it was blank, so its card on the Coop landing page and in the portal had
-- none). Only fills a blank, never overwrites a description someone wrote. Safe to run more than once.
UPDATE coop_addon_modules
   SET description = 'Launch fixed-return or pooled investment products for your members. Track units sold, capital raised and every investor, and pay out returns with a full record.'
 WHERE key = 'investment' AND COALESCE(TRIM(description), '') = '';
