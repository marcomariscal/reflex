-- The card as sent, so an Approve on one card can update the other cards it settles.
alter table reflex.holds add column if not exists card_text text;
