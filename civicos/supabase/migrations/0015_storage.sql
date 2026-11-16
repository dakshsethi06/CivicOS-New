-- CivicOS 0011: private bucket for complaint photos (Supabase Storage).
-- Files live at <organization id>/<user id>/<file>. A user uploads into their own folder;
-- anyone in the same organization who can see the complaint can view the photo through a signed URL
-- issued by the server.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('complaint-photos', 'complaint-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "complaint photos: upload into own folder" on storage.objects;
create policy "complaint photos: upload into own folder" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'complaint-photos'
    and (storage.foldername(name))[1] = (select app.org_id())::text
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

drop policy if exists "complaint photos: read within own organization" on storage.objects;
create policy "complaint photos: read within own organization" on storage.objects for select to authenticated
  using (
    bucket_id = 'complaint-photos'
    and (storage.foldername(name))[1] = (select app.org_id())::text
  );

-- Private bucket for knowledge-base documents. Staff upload into their organization's folder;
-- the server reads the file back to extract its text.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520,
        array['application/pdf', 'text/plain', 'text/csv',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

drop policy if exists "documents: staff upload into own organization" on storage.objects;
create policy "documents: staff upload into own organization" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select app.org_id())::text
    and (select app.role()) in ('city_admin', 'dept_officer')
  );

drop policy if exists "documents: staff read within own organization" on storage.objects;
create policy "documents: staff read within own organization" on storage.objects for select to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select app.org_id())::text
    and (select app.role()) in ('city_admin', 'dept_officer', 'field_worker')
  );

drop policy if exists "documents: staff delete within own organization" on storage.objects;
create policy "documents: staff delete within own organization" on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select app.org_id())::text
    and (select app.role()) in ('city_admin', 'dept_officer')
  );
