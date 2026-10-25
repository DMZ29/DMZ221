import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = express();
const port = Number(process.env.PORT || 4242);
const baseUrl = process.env.APP_BASE_URL;
const root = path.dirname(fileURLToPath(import.meta.url));
let appOrigin = null;
let baseUrlValid = true;
if (baseUrl) {
  try {
    const parsedBaseUrl = new URL(baseUrl);
    if (parsedBaseUrl.protocol !== "https:" && parsedBaseUrl.hostname !== "localhost") {
      throw new Error("APP_BASE_URL must use HTTPS outside localhost.");
    }
    appOrigin = parsedBaseUrl.origin;
  } catch (error) {
    baseUrlValid = false;
    console.error(`Invalid APP_BASE_URL: ${error.message}`);
    process.exitCode = 1;
  }
}
const supportedCountries = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR",
  "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MT",
  "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK"
]);
const euBankTransferCountries = new Set(["BE", "DE", "ES", "FR", "IE", "IT", "NL", "PT"]);
const paymentTypes = {
  card: "card",
  bank: "customer_balance",
  ideal: "ideal",
  bancontact: "bancontact",
  sepa: "sepa_debit"
};

app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
  next();
});

const configuration = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  appBaseUrl: baseUrl
};
const missingConfiguration = Object.entries(configuration)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingConfiguration.length) {
  console.error(`Missing required environment settings: ${missingConfiguration.join(", ")}`);
}

const supabaseAdmin = configuration.supabaseUrl && configuration.supabaseServiceKey
  ? createClient(configuration.supabaseUrl, configuration.supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  : null;
const stripe = configuration.stripeSecretKey
  ? new Stripe(configuration.stripeSecretKey)
  : null;
const feePercent = Number(process.env.PLATFORM_FEE_PERCENT || "0");

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function requireConfiguration(response, settings = configuration) {
  const missing = Object.entries(settings).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    response.status(503).json({ error: "The Buba server is not fully configured.", missing });
    return false;
  }
  return true;
}

function failDatabase(response, message, error) {
  console.error(message, error);
  response.status(500).json({ error: message });
}

async function authenticatedUser(request, response) {
  if (!requireConfiguration(response, {
    supabaseUrl: configuration.supabaseUrl,
    supabaseAnonKey: configuration.supabaseAnonKey,
    supabaseServiceKey: configuration.supabaseServiceKey
  })) return null;

  const authorization = request.get("authorization") || "";
  const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!accessToken) {
    response.status(401).json({ error: "Sign in to continue." });
    return null;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) {
    response.status(401).json({ error: "Your session is invalid or has expired. Please sign in again." });
    return null;
  }
  if (!data.user.email_confirmed_at) {
    response.status(403).json({ error: "Verify your email address before continuing." });
    return null;
  }
  return data.user;
}

app.get("/api/config", (_request, response) => {
  const required = {
    supabaseUrl: configuration.supabaseUrl,
    supabaseAnonKey: configuration.supabaseAnonKey,
    appBaseUrl: configuration.appBaseUrl
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    response.status(503).json({
      error: "The Buba website is not fully configured.",
      missing,
      help: "Copy .env.example to .env, set your Supabase and app URL values, and restart the server."
    });
    return;
  }

  response.json({
    supabaseUrl: configuration.supabaseUrl,
    supabaseAnonKey: configuration.supabaseAnonKey,
    appBaseUrl: configuration.appBaseUrl
  });
});

app.get("/api/products", asyncRoute(async (_request, response) => {
  if (!requireConfiguration(response, {
    supabaseUrl: configuration.supabaseUrl,
    supabaseServiceKey: configuration.supabaseServiceKey
  })) return;

  const { data: products, error } = await supabaseAdmin
    .from("products")
    .select("id, name, category, price_cents, seller_id, created_at")
    .eq("active", true)
    .order("created_at", { ascending: false });
  if (error) return failDatabase(response, "Unable to load products.", error);

  const sellerIds = [...new Set(products.map(product => product.seller_id))];
  const { data: profiles, error: profileError } = sellerIds.length
    ? await supabaseAdmin.from("profiles").select("id, full_name").in("id", sellerIds)
    : { data: [], error: null };
  if (profileError) return failDatabase(response, "Unable to load seller details.", profileError);

  const names = new Map(profiles.map(profile => [profile.id, profile.full_name]));
  response.json({
    products: products.map(product => ({
      id: product.id,
      name: product.name,
      category: product.category,
      price: product.price_cents / 100,
      sellerId: product.seller_id,
      seller: `By ${names.get(product.seller_id) || "Buba seller"}`
    }))
  });
}));

app.post("/api/connect/onboarding", express.json({ limit: "10kb" }), asyncRoute(async (request, response) => {
  const user = await authenticatedUser(request, response);
  if (!user) return;
  if (!requireConfiguration(response, { stripeSecretKey: configuration.stripeSecretKey, appOrigin })) return;

  const country = String(request.body?.country || "").toUpperCase();
  if (!supportedCountries.has(country)) {
    response.status(400).json({ error: "Choose a supported European country." });
    return;
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("stripe_account_id, stripe_account_country")
    .eq("id", user.id)
    .single();
  if (profileError) return failDatabase(response, "Unable to load seller profile.", profileError);

  let accountId = profile.stripe_account_id;
  if (accountId) {
    const account = await stripe.accounts.retrieve(accountId);
    if (account.country !== country) {
      response.status(400).json({ error: `This seller account is registered in ${account.country}; it cannot be changed to ${country}.` });
      return;
    }
    if (account.charges_enabled && account.payouts_enabled) {
      response.json({ connected: true, country: account.country });
      return;
    }
  } else {
    const account = await stripe.accounts.create({
      type: "express",
      country,
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      metadata: { supabase_user_id: user.id }
    });
    accountId = account.id;

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ stripe_account_id: accountId, stripe_account_country: country })
      .eq("id", user.id);
    if (error) return failDatabase(response, "Unable to save the seller payment account.", error);
  }

  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${appOrigin}/?seller=refresh`,
    return_url: `${appOrigin}/?seller=return`,
    type: "account_onboarding"
  });
  response.json({ connected: false, country, url: accountLink.url });
}));

app.get("/api/connect/status", asyncRoute(async (request, response) => {
  const user = await authenticatedUser(request, response);
  if (!user) return;
  if (!requireConfiguration(response, { stripeSecretKey: configuration.stripeSecretKey })) return;

  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("stripe_account_id, stripe_account_country")
    .eq("id", user.id)
    .single();
  if (error) return failDatabase(response, "Unable to load seller status.", error);
  if (!profile.stripe_account_id) {
    response.json({ connected: false, country: null });
    return;
  }

  const account = await stripe.accounts.retrieve(profile.stripe_account_id);
  const connected = account.details_submitted && account.charges_enabled && account.payouts_enabled;
  response.json({ connected, country: account.country || profile.stripe_account_country });
}));

app.post("/api/products", express.json({ limit: "10kb" }), asyncRoute(async (request, response) => {
  const user = await authenticatedUser(request, response);
  if (!user) return;
  if (!requireConfiguration(response, { stripeSecretKey: configuration.stripeSecretKey })) return;

  const name = String(request.body?.name || "").trim();
  const category = String(request.body?.category || "");
  const price = Number(request.body?.price);
  if (name.length < 1 || name.length > 120 || !["Home", "Accessories", "Art", "Clothing", "Other"].includes(category) ||
      !Number.isFinite(price) || price < 0.01 || price > 99999) {
    response.status(400).json({ error: "Enter a valid product name, category, and price." });
    return;
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", user.id)
    .single();
  if (profileError) return failDatabase(response, "Unable to load seller profile.", profileError);
  if (!profile.stripe_account_id) {
    response.status(403).json({ error: "Connect a seller payout account before listing products." });
    return;
  }
  const account = await stripe.accounts.retrieve(profile.stripe_account_id);
  if (!account.details_submitted || !account.charges_enabled || !account.payouts_enabled) {
    response.status(403).json({ error: "Finish setting up your seller payout account before listing products." });
    return;
  }

  const { data: product, error } = await supabaseAdmin
    .from("products")
    .insert({ seller_id: user.id, name, category, price_cents: Math.round(price * 100) })
    .select("id, name, category, price_cents, seller_id")
    .single();
  if (error) return failDatabase(response, "Unable to publish the product.", error);
  response.status(201).json({
    product: {
      id: product.id,
      name: product.name,
      category: product.category,
      price: product.price_cents / 100,
      sellerId: user.id,
      seller: `By ${user.user_metadata?.full_name || "Buba seller"}`
    }
  });
}));

app.post("/api/checkout-session", express.json({ limit: "20kb" }), asyncRoute(async (request, response) => {
  const user = await authenticatedUser(request, response);
  if (!user) return;
  if (!requireConfiguration(response, {
    stripeSecretKey: configuration.stripeSecretKey,
    stripeWebhookSecret: configuration.stripeWebhookSecret,
    supabaseUrl: configuration.supabaseUrl,
    supabaseServiceKey: configuration.supabaseServiceKey,
    appOrigin
  })) return;
  if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 25) {
    response.status(500).json({ error: "The marketplace fee configuration is invalid." });
    return;
  }

  const items = request.body?.items;
  const paymentChoice = String(request.body?.paymentMethod || "");
  if (!Array.isArray(items) || items.length < 1 || items.length > 50 || !paymentTypes[paymentChoice]) {
    response.status(400).json({ error: "Your cart or selected payment method is invalid." });
    return;
  }
  const quantities = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id) ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20 ||
        quantities.has(item.id)) {
      response.status(400).json({ error: "Your cart contains invalid items or quantities." });
      return;
    }
    quantities.set(item.id, item.quantity);
  }
  const deliveryFields = ["full_name", "delivery_address", "city", "postal_code"];
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("full_name, delivery_address, city, postal_code, country")
    .eq("id", user.id)
    .single();
  if (profileError) return failDatabase(response, "Unable to load delivery details.", profileError);
  if (!deliveryFields.every(field => typeof profile[field] === "string" && profile[field].trim().length > 0) ||
      profile.full_name.length > 100 || profile.delivery_address.length > 160 ||
      profile.city.length > 80 || profile.postal_code.length > 20 ||
      !supportedCountries.has(profile.country)) {
    response.status(400).json({ error: "Add valid delivery details and a supported country to your account before checkout." });
    return;
  }
  if (paymentChoice === "bank" && !euBankTransferCountries.has(profile.country)) {
    response.status(400).json({ error: "EU bank transfer is not available for the country on your account. Choose SEPA Direct Debit or another payment method." });
    return;
  }
  if (paymentChoice === "ideal" && profile.country !== "NL") {
    response.status(400).json({ error: "iDEAL is available for customers in the Netherlands." });
    return;
  }
  if (paymentChoice === "bancontact" && profile.country !== "BE") {
    response.status(400).json({ error: "Bancontact is available for customers in Belgium." });
    return;
  }

  const { data: products, error: productError } = await supabaseAdmin
    .from("products")
    .select("id, name, price_cents, seller_id")
    .in("id", [...quantities.keys()])
    .eq("active", true);
  if (productError) return failDatabase(response, "Unable to validate your cart.", productError);
  if (products.length !== quantities.size) {
    response.status(400).json({ error: "A product in your cart is no longer available. Refresh and try again." });
    return;
  }

  const sellerIds = [...new Set(products.map(product => product.seller_id))];
  if (sellerIds.length !== 1) {
    response.status(400).json({ error: "Please check out one seller's products at a time." });
    return;
  }
  const sellerId = sellerIds[0];
  const { data: seller, error: sellerError } = await supabaseAdmin
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", sellerId)
    .single();
  if (sellerError) return failDatabase(response, "Unable to load seller payout details.", sellerError);
  if (!seller.stripe_account_id) {
    response.status(409).json({ error: "This seller has not enabled online checkout yet." });
    return;
  }
  const sellerAccount = await stripe.accounts.retrieve(seller.stripe_account_id);
  if (!sellerAccount.charges_enabled || !sellerAccount.payouts_enabled) {
    response.status(409).json({ error: "This seller is not ready to accept online payments yet." });
    return;
  }

  const totalCents = products.reduce((total, product) =>
    total + product.price_cents * quantities.get(product.id), 0);
  if (!Number.isSafeInteger(totalCents) || totalCents > 99_999_999) {
    response.status(400).json({ error: "The order total is over Stripe's checkout limit." });
    return;
  }
  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .insert({
      buyer_id: user.id,
      seller_id: sellerId,
      status: "pending",
      payment_method: paymentChoice,
      amount_total: totalCents,
      shipping_full_name: profile.full_name,
      shipping_email: user.email,
      shipping_address: profile.delivery_address,
      shipping_city: profile.city,
      shipping_postal_code: profile.postal_code,
      shipping_country: profile.country
    })
    .select("id")
    .single();
  if (orderError) return failDatabase(response, "Unable to start your order.", orderError);
  const { error: itemsError } = await supabaseAdmin.from("order_items").insert(products.map(product => ({
    order_id: order.id,
    product_id: product.id,
    product_name: product.name,
    unit_price_cents: product.price_cents,
    quantity: quantities.get(product.id)
  })));
  if (itemsError) {
    await supabaseAdmin.from("orders").update({ status: "failed" }).eq("id", order.id);
    return failDatabase(response, "Unable to save the order items.", itemsError);
  }

  const paymentMethod = paymentTypes[paymentChoice];
  const paymentMethodOptions = paymentChoice === "bank"
    ? {
      customer_balance: {
        funding_type: "bank_transfer",
        bank_transfer: {
          type: "eu_bank_transfer",
          eu_bank_transfer: { country: profile.country }
        }
      }
    }
    : undefined;
  const paymentIntentData = {
    transfer_data: { destination: seller.stripe_account_id },
    transfer_group: order.id,
    metadata: { order_id: order.id }
  };
  if (feePercent > 0) {
    paymentIntentData.application_fee_amount = Math.round(totalCents * feePercent / 100);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: [paymentMethod],
      ...(paymentMethodOptions ? { payment_method_options: paymentMethodOptions } : {}),
      line_items: products.map(product => ({
        quantity: quantities.get(product.id),
        price_data: {
          currency: "eur",
          unit_amount: product.price_cents,
          product_data: { name: product.name }
        }
      })),
      customer_email: user.email,
      billing_address_collection: "auto",
      client_reference_id: user.id,
      metadata: { order_id: order.id },
      payment_intent_data: paymentIntentData,
      success_url: `${appOrigin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appOrigin}/?checkout=cancelled`
    }, { idempotencyKey: order.id });
    if (!session.url) {
      throw new Error("Stripe did not return a checkout URL.");
    }

    const { error: updateError } = await supabaseAdmin
      .from("orders")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", order.id);
    if (updateError) {
      failDatabase(response, "Unable to save checkout status.", updateError);
      await supabaseAdmin.from("orders").update({ status: "failed" }).eq("id", order.id);
      return;
    }
    response.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    await supabaseAdmin.from("orders").update({ status: "failed" }).eq("id", order.id);
    throw error;
  }
}));

app.get("/api/checkout-status", asyncRoute(async (request, response) => {
  const user = await authenticatedUser(request, response);
  if (!user) return;
  if (!requireConfiguration(response, { stripeSecretKey: configuration.stripeSecretKey })) return;

  const sessionId = String(request.query.session_id || "");
  if (!sessionId.startsWith("cs_")) {
    response.status(400).json({ error: "The checkout session is invalid." });
    return;
  }
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("id, status, amount_total, currency, buyer_id, stripe_checkout_session_id")
    .eq("stripe_checkout_session_id", sessionId)
    .eq("buyer_id", user.id)
    .single();
  if (error || !order) {
    response.status(404).json({ error: "The order could not be found." });
    return;
  }
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.client_reference_id !== user.id || session.metadata?.order_id !== order.id) {
    response.status(403).json({ error: "This checkout session does not belong to your account." });
    return;
  }
  const status = session.payment_status === "paid"
    ? "paid"
    : session.status === "expired" ? "expired" : "awaiting_payment";
  response.json({ status, amount: order.amount_total / 100, currency: order.currency });
}));

app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), asyncRoute(async (request, response) => {
  if (!requireConfiguration(response, {
    stripeSecretKey: configuration.stripeSecretKey,
    stripeWebhookSecret: configuration.stripeWebhookSecret,
    supabaseUrl: configuration.supabaseUrl,
    supabaseServiceKey: configuration.supabaseServiceKey
  })) return;

  let event;
  try {
    event = stripe.webhooks.constructEvent(request.body, request.get("stripe-signature"), configuration.stripeWebhookSecret);
  } catch (error) {
    console.error("Stripe webhook signature verification failed.", error.message);
    response.status(400).send("Invalid webhook signature.");
    return;
  }

  const session = event.data.object;
  const orderId = session.metadata?.order_id;
  if (orderId && event.type.startsWith("checkout.session.")) {
    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .select("id, status, amount_total, currency, stripe_checkout_session_id")
      .eq("id", orderId)
      .maybeSingle();
    if (orderError) return failDatabase(response, "Unable to find the order for the payment event.", orderError);
    if (!order || order.stripe_checkout_session_id !== session.id ||
        order.amount_total !== session.amount_total || order.currency !== session.currency) {
      console.error("Stripe checkout event did not match its Buba order.", { orderId, sessionId: session.id });
      response.status(400).send("Checkout event does not match an order.");
      return;
    }

    const statusByEvent = {
      "checkout.session.completed": session.payment_status === "paid" ? "paid" : "awaiting_payment",
      "checkout.session.async_payment_succeeded": "paid",
      "checkout.session.async_payment_failed": "failed",
      "checkout.session.expired": "expired"
    };
    const status = statusByEvent[event.type];
    if (status) {
      let update = supabaseAdmin.from("orders").update({ status }).eq("id", orderId);
      if (status === "awaiting_payment") {
        update = update.eq("status", "pending");
      } else if (status !== "paid") {
        update = update.in("status", ["pending", "awaiting_payment"]);
      }
      const { error } = await update;
      if (error) return failDatabase(response, "Unable to update the order from the payment event.", error);
    }
  }
  response.json({ received: true });
}));

app.use(express.json({ limit: "20kb" }));
app.get("/", (_request, response) => response.sendFile(path.join(root, "index.html")));

app.use((error, _request, response, _next) => {
  console.error("Unhandled Buba request error.", error);
  if (response.headersSent) return;
  response.status(500).json({ error: "The request could not be completed." });
});

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be a valid TCP port.");
  process.exitCode = 1;
} else if (baseUrlValid) {
  app.listen(port, () => {
    console.log(`Buba server listening on port ${port}.`);
  });
}
