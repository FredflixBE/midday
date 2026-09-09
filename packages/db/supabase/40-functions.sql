-- 40-functions.sql — the functions the application calls at runtime.
--
-- Run after `drizzle-kit push`: every one of these reads tables it creates.
-- Idempotent: all CREATE OR REPLACE.
--
-- Two halves, and the difference matters when you are reading them.
--
-- The first five are recovered verbatim from the Supabase dumps deleted in
-- c5ac672f3, so the dump is the authority on what they should do.
--
-- The last four are NOT in any dump — they postdate April 2025 and existed
-- only in Midday's hosted project. They are written here against the contract
-- the code states: the argument order in packages/db/src/queries, the return
-- shape in packages/supabase/src/types/db.ts, and, for the `data` payload,
-- the fields apps/dashboard/src/components/search/search.tsx reads for each
-- result type. Where the contract is silent, the choice is called out.

-- ===========================================================================
-- Recovered
-- ===========================================================================

-- The distinct currencies a team holds accounts in.
create or replace function public.get_bank_account_currencies(team_id uuid)
returns table(currency text)
language plpgsql
as $$
begin
  return query
    select distinct bank_accounts.currency
      from bank_accounts
     where bank_accounts.team_id = get_bank_account_currencies.team_id
     order by bank_accounts.currency;
end;
$$;

-- Used by the generate_slug_from_name trigger on transaction_categories.
-- Needs the unaccent extension, which 00-bootstrap.sql installs.
create or replace function public.slugify(value text)
returns text
language sql
immutable
strict
as $_$
  with "unaccented" as (
    select unaccent("value") as "value"
  ),
  "lowercase" as (
    select lower("value") as "value" from "unaccented"
  ),
  "removed_quotes" as (
    select regexp_replace("value", '[''"]+', '', 'gi') as "value" from "lowercase"
  ),
  "hyphenated" as (
    select regexp_replace("value", '[^a-z0-9\-_]+', '-', 'gi') as "value" from "removed_quotes"
  ),
  "trimmed" as (
    select regexp_replace(regexp_replace("value", '\-+$', ''), '^\-', '') as "value" from "hyphenated"
  )
  select "value" from "trimmed";
$_$;

-- Seconds tracked against a project. Called as total_duration(tracker_projects).
create or replace function public.total_duration(public.tracker_projects)
returns integer
language sql
as $_$
  select sum(tracker_entries.duration) as total_duration
    from tracker_projects
    join tracker_entries on tracker_projects.id = tracker_entries.project_id
   where tracker_projects.id = $1.id
   group by tracker_projects.id;
$_$;

-- Billable value of a project at its hourly rate.
create or replace function public.get_project_total_amount(public.tracker_projects)
returns numeric
language sql
as $_$
  select coalesce(
    (select
       case when $1.rate is not null
            then round(sum(te.duration) * $1.rate / 3600, 2)
            else 0
       end
       from public.tracker_entries te
      where te.project_id = $1.id),
    0
  );
$_$;

-- Everyone who has tracked time against a project.
create or replace function public.get_assigned_users_for_project(public.tracker_projects)
returns json
language sql
as $_$
  select coalesce(
    (select json_agg(
       json_build_object('user_id', u.id, 'full_name', u.full_name, 'avatar_url', u.avatar_url)
     )
     from (
       select distinct u.id, u.full_name, u.avatar_url
         from public.users u
         join public.tracker_entries te on u.id = te.assigned_id
        where te.project_id = $1.id
     ) u),
    '[]'::json
  );
$_$;

-- ===========================================================================
-- Authored — no dump to recover these from
-- ===========================================================================

-- Every enabled account a team holds, with the logo of the bank it came from.
-- Manual accounts have no connection and so no logo.
create or replace function public.get_team_bank_accounts_balances(team_id uuid)
returns table(
  id uuid,
  name text,
  currency text,
  balance numeric,
  logo_url text
)
language sql
stable
as $$
  select
    ba.id,
    ba.name,
    ba.currency,
    coalesce(ba.balance, 0) as balance,
    bc.logo_url
  from bank_accounts ba
  left join bank_connections bc on bc.id = ba.bank_connection_id
  where ba.team_id = get_team_bank_accounts_balances.team_id
    and ba.enabled is true
  order by ba.created_at;
$$;

-- The ⌘K search: one ranked list across everything a team owns.
--
-- Prefetched on every page with an empty term, which is why an empty term is
-- a supported case rather than an error — it returns what is most recent,
-- which is what the palette shows before you type.
--
-- `type` values are the ones apps/dashboard's search.tsx switches on, and the
-- `data` payload carries exactly the fields it reads for each. The `url` on a
-- transaction is what its copy button copies; nothing else needs one.
create or replace function public.global_search(
  p_search_term text,
  p_team_id uuid,
  p_search_lang text default 'english',
  p_limit integer default 30,
  p_items_per_table_limit integer default 5,
  p_relevance_threshold numeric default 0.01
)
returns table(
  id uuid,
  type text,
  title text,
  relevance numeric,
  created_at timestamptz,
  data jsonb
)
language plpgsql
stable
as $$
declare
  -- An unknown configuration name would raise; english is what every fts
  -- column in the schema is built with anyway.
  v_config regconfig := 'english'::regconfig;
  v_query tsquery;
  v_searching boolean := coalesce(trim(p_search_term), '') <> '';
  v_per_table integer := greatest(coalesce(p_items_per_table_limit, 5), 1);
  v_limit integer := greatest(coalesce(p_limit, 30), 1);
  v_threshold numeric := coalesce(p_relevance_threshold, 0.01);
begin
  if v_searching then
    -- websearch_to_tsquery never raises on user input, unlike to_tsquery.
    v_query := websearch_to_tsquery(v_config, p_search_term);
  end if;

  return query
  with ranked as (
    (
      select t.id, 'transaction'::text as type,
             t.name as title,
             case when v_searching then ts_rank(t.fts_vector, v_query)::numeric else 1 end as relevance,
             t.created_at,
             jsonb_build_object(
               'name', t.name,
               'amount', t.amount,
               'currency', t.currency,
               'date', t.date,
               'url', concat('/transactions?transactionId=', t.id)
             ) as data
        from transactions t
       where t.team_id = p_team_id
         and (not v_searching or t.fts_vector @@ v_query)
       order by case when v_searching then ts_rank(t.fts_vector, v_query) end desc nulls last,
                t.created_at desc
       limit v_per_table
    )
    union all
    (
      select i.id, 'invoice'::text,
             coalesce(i.invoice_number, i.customer_name, 'Invoice'),
             case when v_searching then ts_rank(i.fts, v_query)::numeric else 1 end,
             i.created_at,
             jsonb_build_object(
               'invoice_number', i.invoice_number,
               'status', i.status,
               'amount', i.amount,
               'currency', i.currency,
               'template', i.template
             )
        from invoices i
       where i.team_id = p_team_id
         and (not v_searching or i.fts @@ v_query)
       order by case when v_searching then ts_rank(i.fts, v_query) end desc nulls last,
                i.created_at desc
       limit v_per_table
    )
    union all
    (
      select c.id, 'customer'::text,
             c.name,
             case when v_searching then ts_rank(c.fts, v_query)::numeric else 1 end,
             c.created_at,
             jsonb_build_object('name', c.name, 'email', c.email, 'website', c.website)
        from customers c
       where c.team_id = p_team_id
         and (not v_searching or c.fts @@ v_query)
       order by case when v_searching then ts_rank(c.fts, v_query) end desc nulls last,
                c.created_at desc
       limit v_per_table
    )
    union all
    (
      -- The vault. Folder placeholders are not documents; the queries in
      -- packages/db/src/queries/documents.ts filter them the same way.
      select d.id, 'vault'::text,
             coalesce(d.title, d.name),
             case when v_searching then ts_rank(d.fts, v_query)::numeric else 1 end,
             d.created_at,
             jsonb_build_object(
               'title', d.title,
               'name', d.name,
               'path_tokens', d.path_tokens,
               'metadata', d.metadata,
               'summary', d.summary
             )
        from documents d
       where d.team_id = p_team_id
         and d.name not like '%.folderPlaceholder'
         and (not v_searching or d.fts @@ v_query)
       order by case when v_searching then ts_rank(d.fts, v_query) end desc nulls last,
                d.created_at desc
       limit v_per_table
    )
    union all
    (
      select p.id, 'tracker_project'::text,
             p.name,
             case when v_searching then ts_rank(p.fts, v_query)::numeric else 1 end,
             p.created_at,
             jsonb_build_object(
               'name', p.name,
               'description', p.description,
               'status', p.status,
               'currency', p.currency
             )
        from tracker_projects p
       where p.team_id = p_team_id
         and (not v_searching or p.fts @@ v_query)
       order by case when v_searching then ts_rank(p.fts, v_query) end desc nulls last,
                p.created_at desc
       limit v_per_table
    )
    union all
    (
      select n.id, 'inbox'::text,
             coalesce(n.display_name, n.file_name, 'Inbox item'),
             case when v_searching then ts_rank(n.fts, v_query)::numeric else 1 end,
             n.created_at,
             jsonb_build_object(
               'display_name', n.display_name,
               'file_name', n.file_name,
               'file_path', n.file_path,
               'amount', n.amount,
               'currency', n.currency,
               'date', n.date
             )
        from inbox n
       where n.team_id = p_team_id
         and (not v_searching or n.fts @@ v_query)
       order by case when v_searching then ts_rank(n.fts, v_query) end desc nulls last,
                n.created_at desc
       limit v_per_table
    )
  )
  select r.id, r.type, r.title, r.relevance, r.created_at, r.data
    from ranked r
   where not v_searching or r.relevance >= v_threshold
   order by case when v_searching then r.relevance end desc nulls last,
            r.created_at desc
   limit v_limit;
end;
$$;

-- The fallback the API reaches for when a multi-word search finds nothing and
-- an LLM has turned the phrase into filters. Same result shape as
-- global_search; the difference is that it filters rather than ranks, and only
-- looks at the entity types it was asked for.
--
-- Argument order is fixed by the call site in packages/db/src/queries/search.ts
-- and cannot be reordered without changing it.
create or replace function public.global_semantic_search(
  team_id uuid,
  search_term text default null,
  start_date text default null,
  end_date text default null,
  types text[] default null,
  amount numeric default null,
  amount_min numeric default null,
  amount_max numeric default null,
  status text default null,
  currency text default null,
  language text default null,
  due_date_start text default null,
  due_date_end text default null,
  max_results integer default 20,
  items_per_table_limit integer default 5
)
returns table(
  id uuid,
  type text,
  title text,
  relevance numeric,
  created_at timestamptz,
  data jsonb
)
language plpgsql
stable
as $$
declare
  v_config regconfig := 'english'::regconfig;
  v_query tsquery;
  v_searching boolean := coalesce(trim(search_term), '') <> '';
  v_per_table integer := greatest(coalesce(items_per_table_limit, 5), 1);
  v_limit integer := greatest(coalesce(max_results, 20), 1);
  v_from date := case when start_date is null then null else start_date::date end;
  v_to date := case when end_date is null then null else end_date::date end;
  v_due_from date := case when due_date_start is null then null else due_date_start::date end;
  v_due_to date := case when due_date_end is null then null else due_date_end::date end;
  -- A null list means every type, which is how the API calls it when the LLM
  -- did not narrow one.
  v_wants_all boolean := types is null or cardinality(types) = 0;
  -- amount, status and currency are also column names, and an unqualified
  -- reference to one inside the query below is ambiguous. Copy them out.
  v_team_id uuid := team_id;
  v_types text[] := types;
  v_amount numeric := amount;
  v_amount_min numeric := amount_min;
  v_amount_max numeric := amount_max;
  v_status text := status;
  v_currency text := currency;
begin
  if v_searching then
    v_query := websearch_to_tsquery(v_config, search_term);
  end if;

  return query
  with ranked as (
    (
      select t.id, 'transaction'::text as type,
             t.name as title,
             case when v_searching then ts_rank(t.fts_vector, v_query)::numeric else 1 end as relevance,
             t.created_at,
             jsonb_build_object(
               'name', t.name,
               'amount', t.amount,
               'currency', t.currency,
               'date', t.date,
               'url', concat('/transactions?transactionId=', t.id)
             ) as data
        from transactions t
       where t.team_id = v_team_id
         and (v_wants_all or 'transactions' = any(v_types))
         and (not v_searching or t.fts_vector @@ v_query)
         and (v_from is null or t.date >= v_from)
         and (v_to is null or t.date <= v_to)
         and (v_currency is null or t.currency = v_currency)
         and (v_amount is null or abs(t.amount) = abs(v_amount))
         and (v_amount_min is null or abs(t.amount) >= v_amount_min)
         and (v_amount_max is null or abs(t.amount) <= v_amount_max)
       order by t.date desc, t.created_at desc
       limit v_per_table
    )
    union all
    (
      select i.id, 'invoice'::text,
             coalesce(i.invoice_number, i.customer_name, 'Invoice'),
             case when v_searching then ts_rank(i.fts, v_query)::numeric else 1 end,
             i.created_at,
             jsonb_build_object(
               'invoice_number', i.invoice_number,
               'status', i.status,
               'amount', i.amount,
               'currency', i.currency,
               'template', i.template
             )
        from invoices i
       where i.team_id = v_team_id
         and (v_wants_all or 'invoices' = any(v_types))
         and (not v_searching or i.fts @@ v_query)
         and (v_from is null or i.issue_date >= v_from)
         and (v_to is null or i.issue_date <= v_to)
         and (v_due_from is null or i.due_date >= v_due_from)
         and (v_due_to is null or i.due_date <= v_due_to)
         and (v_currency is null or i.currency = v_currency)
         and (v_status is null or i.status::text = v_status)
         and (v_amount is null or i.amount = v_amount)
         and (v_amount_min is null or i.amount >= v_amount_min)
         and (v_amount_max is null or i.amount <= v_amount_max)
       order by i.created_at desc
       limit v_per_table
    )
    union all
    (
      select c.id, 'customer'::text,
             c.name,
             case when v_searching then ts_rank(c.fts, v_query)::numeric else 1 end,
             c.created_at,
             jsonb_build_object('name', c.name, 'email', c.email, 'website', c.website)
        from customers c
       where c.team_id = v_team_id
         and (v_wants_all or 'customers' = any(v_types))
         and (not v_searching or c.fts @@ v_query)
       order by c.created_at desc
       limit v_per_table
    )
    union all
    (
      select d.id, 'vault'::text,
             coalesce(d.title, d.name),
             case when v_searching then ts_rank(d.fts, v_query)::numeric else 1 end,
             d.created_at,
             jsonb_build_object(
               'title', d.title,
               'name', d.name,
               'path_tokens', d.path_tokens,
               'metadata', d.metadata,
               'summary', d.summary
             )
        from documents d
       where d.team_id = v_team_id
         and (v_wants_all or 'documents' = any(v_types))
         and d.name not like '%.folderPlaceholder'
         and (not v_searching or d.fts @@ v_query)
         and (v_from is null or d.date >= v_from)
         and (v_to is null or d.date <= v_to)
       order by d.created_at desc
       limit v_per_table
    )
    union all
    (
      select p.id, 'tracker_project'::text,
             p.name,
             case when v_searching then ts_rank(p.fts, v_query)::numeric else 1 end,
             p.created_at,
             jsonb_build_object(
               'name', p.name,
               'description', p.description,
               'status', p.status,
               'currency', p.currency
             )
        from tracker_projects p
       where p.team_id = v_team_id
         and (v_wants_all or 'tracker_projects' = any(v_types))
         and (not v_searching or p.fts @@ v_query)
         and (v_currency is null or p.currency = v_currency)
         and (v_status is null or p.status::text = v_status)
       order by p.created_at desc
       limit v_per_table
    )
  )
  select r.id, r.type, r.title, r.relevance, r.created_at, r.data
    from ranked r
   order by case when v_searching then r.relevance end desc nulls last,
            r.created_at desc
   limit v_limit;
end;
$$;

-- Documents whose title reads like another document's, for the "related"
-- list in the vault. Trigram similarity, which idx_gin_documents_title backs.
create or replace function public.match_similar_documents_by_title(
  source_document_id uuid,
  p_team_id uuid,
  match_threshold numeric default 0.3,
  match_count integer default 20
)
returns table(
  id uuid,
  name text,
  metadata jsonb,
  path_tokens text[],
  tag text,
  title text,
  summary text,
  title_similarity numeric
)
language sql
stable
as $$
  with source as (
    select d.title
      from documents d
     where d.id = source_document_id
       and d.team_id = p_team_id
  )
  select
    d.id,
    d.name,
    d.metadata,
    d.path_tokens,
    d.tag,
    d.title,
    d.summary,
    similarity(d.title, source.title)::numeric as title_similarity
  from documents d, source
  where d.team_id = p_team_id
    and d.id <> source_document_id
    and d.title is not null
    and source.title is not null
    and d.name not like '%.folderPlaceholder'
    and similarity(d.title, source.title) >= coalesce(match_threshold, 0.3)
  order by similarity(d.title, source.title) desc, d.created_at desc
  limit coalesce(match_count, 20);
$$;
