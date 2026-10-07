-- Custom SQL migration file, put your code below! --
UPDATE articles SET status = 'archived' WHERE status = 'read';
