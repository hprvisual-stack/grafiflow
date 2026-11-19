-- Execute once in the production Supabase SQL Editor while the product is a free beta.
-- This disables subscription gating only. Workspace membership and record RLS policies
-- remain in force, so accounts still cannot read another workspace's data.
begin;

update private.grafiflow_billing_settings
set enforcement_enabled = false,
    updated_at = now()
where singleton = true;

select enforcement_enabled
from private.grafiflow_billing_settings
where singleton = true;

commit;
