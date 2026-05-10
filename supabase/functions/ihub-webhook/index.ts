// iHub (iFood) webhook receiver
// URL pública para configurar no painel iHub:
//   {SUPABASE_URL}/functions/v1/ihub-webhook
//
// O iHub envia POST com:
//   - Header `X-iFood-Hub-Signature` = secret_token cadastrado pelo cliente
//   - Body JSON conforme docs (https://ihub.arcn.com.br/docs)
//
// Identificamos o restaurante combinando o secret_token (autenticidade) com
// o merchantId do payload. Em PLC (PLACED), criamos o pedido em `orders` com
// os dados completos vindos em `order_details`. Em demais eventos atualizamos
// o status do pedido correspondente.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ifood-hub-signature, accept",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type IHubEvent = {
  id?: string;
  code?: string;
  fullCode?: string;
  orderId?: string;
  merchantId?: string;
  createdAt?: string;
  order_details?: any;
};

const STATUS_MAP: Record<string, string> = {
  PLACED: "pending",
  CONFIRMED: "accepted",
  PREPARATION_STARTED: "preparing",
  READY_TO_PICKUP: "awaiting_pickup",
  DISPATCHED: "out_for_delivery",
  CONCLUDED: "delivered",
  CANCELLED: "cancelled",
  PLC: "pending",
  CFM: "accepted",
  RTP: "awaiting_pickup",
  DSP: "out_for_delivery",
  CON: "delivered",
  CAN: "cancelled",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function findIntegration(token: string, merchantId?: string) {
  if (merchantId) {
    const { data } = await supabase
      .from("ihub_integrations")
      .select("*")
      .eq("secret_token", token)
      .eq("merchant_id", merchantId)
      .maybeSingle();
    if (data) return data;
  }
  const { data } = await supabase
    .from("ihub_integrations")
    .select("*")
    .eq("secret_token", token)
    .is("merchant_id", null)
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

async function createOrderFromPlaced(integration: any, ev: IHubEvent) {
  const od = ev.order_details ?? {};
  const customer = od.customer ?? {};
  const addr = od.deliveryAddress ?? {};
  const items = Array.isArray(od.items) ? od.items : [];
  const total = od.total ?? {};
  const payments = Array.isArray(od.payments?.methods) ? od.payments.methods : [];
  const phone = typeof customer.phone === "object" ? customer.phone?.number : customer.phone;
  const paymentMethod = payments.some((p: any) => String(p.method ?? "").toUpperCase().includes("CASH"))
    ? "cash"
    : payments.some((p: any) => String(p.method ?? "").toUpperCase().includes("PIX"))
      ? "pix"
      : "card_on_delivery";
  const orderType = String(od.orderType ?? od.type ?? "").toUpperCase() === "TAKEOUT" ? "pickup" : "delivery";

  const { data: existing } = await supabase
    .from("orders")
    .select("id")
    .eq("restaurant_id", integration.restaurant_id)
    .eq("external_source", "ifood")
    .eq("external_order_id", ev.orderId)
    .maybeSingle();
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from("orders")
    .insert({
      restaurant_id: integration.restaurant_id,
      customer_name: customer.name ?? "Cliente iFood",
      customer_phone: phone ?? "Não informado",
      payment_method: paymentMethod,
      address_street: orderType === "pickup" ? "Retirada iFood" : (addr.streetName ?? null),
      address_number: orderType === "pickup" ? "—" : (addr.streetNumber ?? null),
      address_neighborhood: orderType === "pickup" ? "—" : (addr.neighborhood ?? null),
      address_city: orderType === "pickup" ? "—" : (addr.city ?? null),
      address_state: orderType === "pickup" ? "—" : (addr.state ?? null),
      address_cep: addr.postalCode ?? null,
      address_complement: addr.complement ?? null,
      address_notes: [addr.reference, od.displayId ? `iFood #${od.displayId}` : null].filter(Boolean).join("\n") || null,
      subtotal: Number(total.subTotal ?? 0),
      delivery_fee: Number(total.deliveryFee ?? 0),
      total: Number(total.orderAmount ?? 0),
      status: "pending",
      order_type: orderType,
      external_source: "ifood",
      external_order_id: ev.orderId,
    })
    .select("id")
    .single();
  if (error) throw error;

  if (items.length) {
    const rows = items.map((it: any) => {
      const subItems = Array.isArray(it.subItems) ? it.subItems : [];
      const subNotes = subItems
        .map((s: any) => `${s.quantity ?? 1}x ${s.name ?? s.itemName ?? "Complemento"}`)
        .join("\n");
      const notes = [it.observations, subNotes].filter(Boolean).join("\n") || null;
      return {
        order_id: data.id,
        product_id: null,
        product_name: it.name ?? "Item iFood",
        unit_price: Number(it.unitPrice ?? 0),
        quantity: Math.max(1, Number(it.quantity ?? 1)),
        notes,
      };
    });
    const { error: itemsError } = await supabase.from("order_items").insert(rows);
    if (itemsError) throw itemsError;
  }

  return data.id;
}

async function updateStatus(integration: any, ev: IHubEvent) {
  const status = STATUS_MAP[ev.fullCode ?? ""] ?? STATUS_MAP[ev.code ?? ""];
  if (!status || !ev.orderId) return;
  await supabase
    .from("orders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("restaurant_id", integration.restaurant_id)
    .eq("external_source", "ifood")
    .eq("external_order_id", ev.orderId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const signature = req.headers.get("x-ifood-hub-signature") ?? "";
  if (!signature) return jsonResponse({ error: "Missing X-iFood-Hub-Signature" }, 401);

  let ev: IHubEvent;
  try {
    ev = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const integration = await findIntegration(signature, ev.merchantId);
  if (!integration) return jsonResponse({ error: "Unknown token / merchant not linked" }, 401);

  const { data: logged } = await supabase
    .from("ihub_events")
    .insert({
      integration_id: integration.id,
      restaurant_id: integration.restaurant_id,
      event_id: ev.id ?? null,
      code: ev.code ?? null,
      full_code: ev.fullCode ?? null,
      order_id: ev.orderId ?? null,
      merchant_id: ev.merchantId ?? null,
      payload: ev,
    })
    .select("id")
    .single();

  let processError: string | null = null;
  try {
    if (!integration.enabled) {
      processError = "integration_disabled";
    } else if (ev.fullCode === "PLACED" || ev.code === "PLC") {
      await createOrderFromPlaced(integration, ev);
    } else {
      await updateStatus(integration, ev);
    }
  } catch (e: any) {
    processError = e?.message ?? String(e);
    console.error("ihub-webhook process error", processError);
  }

  await supabase
    .from("ihub_integrations")
    .update({
      last_event_at: new Date().toISOString(),
      last_event_code: ev.fullCode ?? ev.code ?? null,
      merchant_id: integration.merchant_id ?? ev.merchantId ?? null,
    })
    .eq("id", integration.id);

  if (logged?.id) {
    await supabase
      .from("ihub_events")
      .update({ processed: !processError, error: processError })
      .eq("id", logged.id);
  }

  return jsonResponse({ ok: true });
});
