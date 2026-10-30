-- Run once in the Supabase SQL Editor.
-- Stores how many real meters one basemap pixel represents.
alter table public.sites
  add column if not exists meters_per_pixel double precision;
