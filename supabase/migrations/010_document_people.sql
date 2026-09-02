-- Label documents with family member names, same style as events/tasks.
alter table family_documents add column if not exists people text[] default null;
