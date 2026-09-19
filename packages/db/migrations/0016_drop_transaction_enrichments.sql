-- FF-1601: the supplier entity has taken over this table's job. It had no
-- rows, and no function, view, policy or foreign key referred to it on
-- Frankfurt (checked 2026-09-19).
DROP TABLE "transaction_enrichments" CASCADE;