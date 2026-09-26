-- Separate unused reverse-shipment refunds from outbound postage and Stripe.
-- Existing rows, uniqueness, forced RLS and server-only grants are preserved.
alter table public.pilot_operations drop constraint pilot_operations_kind_check;
alter table public.pilot_operations add constraint pilot_operations_kind_check
  check (kind in ('quote','checkout','label','refund','cancel_checkout','label_refund','payout','return_quote','return_label','return_label_refund'));
