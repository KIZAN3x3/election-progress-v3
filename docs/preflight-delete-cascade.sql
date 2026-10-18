-- Read-only deployment prerequisite. Project: hhlqgxmhbpfhjnjmradq.
-- Require exactly one row, validated=true and delete_cascade=true.
-- This constraint was observed in extended-platform-audit-20261018.json.
select conname, convalidated as validated, confdeltype='c' as delete_cascade
from pg_constraint
where contype='f'
  and conrelid='public.v3_progress'::regclass
  and confrelid='public.v3_candidates'::regclass
  and conkey=array[(select attnum from pg_attribute where attrelid='public.v3_progress'::regclass and attname='candidate_id' and not attisdropped)]
  and confkey=array[(select attnum from pg_attribute where attrelid='public.v3_candidates'::regclass and attname='id' and not attisdropped)];
