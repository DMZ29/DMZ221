create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 100),
  delivery_address text not null default '' check (char_length(delivery_address) <= 160),
  city text not null default '' check (char_length(city) <= 80),
  postal_code text not null default '' check (char_length(postal_code) <= 20),
  country text not null default 'IE' check (country ~ '^[A-Z]{2}$'),
  stripe_account_id text unique,
  stripe_account_country text check (stripe_account_country is null or stripe_account_country ~ '^[A-Z]{2}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  category text not null check (category in ('Home', 'Accessories', 'Art', 'Clothing', 'Other')),
  price_cents integer not null check (price_cents between 1 and 9999999),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.profiles (id),
  seller_id uuid not null references public.profiles (id),
  stripe_checkout_session_id text unique,
  status text not null default 'pending'
    check (status in ('pending', 'awaiting_payment', 'paid', 'failed', 'expired')),
  payment_method text not null check (payment_method in ('card', 'bank', 'ideal', 'bancontact', 'sepa')),
  amount_total integer not null check (amount_total > 0),
  currency text not null default 'eur' check (currency = 'eur'),
  shipping_full_name text not null,
  shipping_email text not null,
  shipping_address text not null,
  shipping_city text not null,
  shipping_postal_code text not null,
  shipping_country text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid references public.products (id) on delete set null,
  product_name text not null,
  unit_price_cents integer not null check (unit_price_cents > 0),
  quantity integer not null check (quantity between 1 and 20)
);

create index if not exists products_active_created_idx
  on public.products (active, created_at desc);
create index if not exists products_seller_idx
  on public.products (seller_id);
create index if not exists orders_buyer_created_idx
  on public.orders (buyer_id, created_at desc);
create index if not exists orders_seller_created_idx
  on public.orders (seller_id, created_at desc);
create index if not exists order_items_order_idx
  on public.order_items (order_id);

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, delivery_address, city, postal_code, country)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'delivery_address', ''),
    coalesce(new.raw_user_meta_data ->> 'city', ''),
    coalesce(new.raw_user_meta_data ->> 'postal_code', ''),
    coalesce(new.raw_user_meta_data ->> 'country', 'IE')
  )
  on conflict (id) do update set
    full_name = excluded.full_name,
    delivery_address = excluded.delivery_address,
    city = excluded.city,
    postal_code = excluded.postal_code,
    country = excluded.country,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of raw_user_meta_data on auth.users
  for each row execute procedure public.create_profile_for_new_user();

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists "Users can read their profile" on public.profiles;
create policy "Users can read their profile"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
grant select on public.profiles to authenticated;

drop policy if exists "Users can update their profile" on public.profiles;
create policy "Users can update their profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

revoke update on public.profiles from authenticated;
grant update (full_name, delivery_address, city, postal_code, country)
  on public.profiles to authenticated;

drop policy if exists "Anyone can read active products" on public.products;
create policy "Anyone can read active products"
  on public.products for select to anon, authenticated
  using (active);
grant select on public.products to anon, authenticated;

drop policy if exists "Sellers can manage their products" on public.products;
create policy "Sellers can manage their products"
  on public.products for all to authenticated
  using ((select auth.uid()) = seller_id)
  with check ((select auth.uid()) = seller_id);
revoke insert, update, delete on public.products from authenticated;

drop policy if exists "Buyers and sellers can read orders" on public.orders;
create policy "Buyers and sellers can read orders"
  on public.orders for select to authenticated
  using ((select auth.uid()) = buyer_id or (select auth.uid()) = seller_id);
grant select on public.orders to authenticated;

drop policy if exists "Buyers and sellers can read order items" on public.order_items;
create policy "Buyers and sellers can read order items"
  on public.order_items for select to authenticated
  using (
    exists (
      select 1
      from public.orders
      where public.orders.id = order_id
        and ((select auth.uid()) = buyer_id or (select auth.uid()) = seller_id)
    )
  );
grant select on public.order_items to authenticated;

revoke insert, update, delete on public.orders from anon, authenticated;
revoke insert, update, delete on public.order_items from anon, authenticated;
