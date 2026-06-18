-- Back-fill the canonical values on the standard roles.
--
-- Seeds are insert-only (schema-flow >= 0.13.0), so on a database that already
-- had the `roles` rows before this library shipped display_name / description /
-- is_default / is_privilege, the seed never runs and those rows keep the column
-- defaults — most importantly `is_default = false` for *every* role. withSession
-- selects the default role from `is_default = true`, so with nothing flagged
-- there is no default role and every session that doesn't request one explicitly
-- breaks. The library is the only thing that knows the canonical set, so it owns
-- the back-fill rather than leaving each consumer to discover the gap at runtime.
--
-- The `display_name IS NULL` guard makes this idempotent and a no-op on a fresh
-- database (the seed already wrote the values), and leaves a role a consumer has
-- deliberately renamed/customised untouched. `deleted_at IS NULL` keeps it to the
-- live rows the partial-unique name index covers.
--
-- The audit trigger stamps updated_by from app.actor_id; set it to the app-init
-- principal first so the touched rows get a valid attribution (and so this works
-- on @smplcty/schema-std >= 0.1.0, which rejects actor-less writes outright).
SELECT set_config(
  'app.actor_id',
  (SELECT user_id::text FROM users WHERE name = 'app-init' AND kind = 'service'),
  true
);

UPDATE roles r
   SET display_name = v.display_name,
       description  = v.description,
       is_default   = v.is_default,
       is_privilege = v.is_privilege
  FROM (VALUES
    ('user',     'User',     'Standard signed-in user.',                  true,  false),
    ('settings', 'Settings', 'Account and organisation settings access.', false, false),
    ('security', 'Security', 'Security administration.',                  false, false)
  ) AS v (name, display_name, description, is_default, is_privilege)
 WHERE r.name = v.name
   AND r.display_name IS NULL
   AND r.deleted_at IS NULL;
