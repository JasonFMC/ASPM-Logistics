-- Optional: remove unused preset areas that have no outline (run once in SQL Editor if list is cluttered)
delete from public.areas
where polygon is null
  and code in ('A','B','E','F','G','H','I','J','L','M','N');
