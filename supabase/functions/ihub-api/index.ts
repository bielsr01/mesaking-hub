// Proxy para a API oficial do iHub (https://ihub.arcn.com.br/api)
//
// Lemos o secret_token e o domain do registro `ihub_integrations` do
// restaurante, e encaminhamos a requisição para o iHub usando
// `Authorization: Bearer {secret_token}`.
//
// Ações suportadas (body { action, restaurantId, ... }):
//   - "generate-user-code"     → POST /auth/generate-user-code
//   - "link-merchant"          → POST /auth/link-merchant
//   - "order-action"           → POST /ifood/action
//   - "order-details"          → GET  /orders/{merchantId}/{orderId}
//   - "cancellation-reasons"   → GET  /orders/{merchantId}/{orderId}/cancellation-reasons
//
// Sempre retornamos { ok, status, data } para o front-end exibir o erro real
// quando a chamada falhar.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const IHUB_BASE = "https://ihub.arcn.com.br/api";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function callIhub(opts: {
  method: "GET" | "POST";
  path: string;
  token: string;
  body?: unknown;
}) {
  const r = await fetch(`${IHUB_BASE}${opts.path}`, {
    method: opts.method,
    headers: {
      "Authorization": `Bearer ${opts.token.trim()}`,
      "Accept": "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 1000) }; }
  return { ok: r.ok, status: r.status, data };
}

function ihubErrorMessage(data: any, fallback: string) {
  const msg = data?.message ?? data?.error ?? data?.errors ?? data?.raw;
  if (!msg) return fallback;
  return typeof msg === "string" ? msg : JSON.stringify(msg);
}

function pickIhubData(data: any) {
  return data?.data ?? data?.result ?? data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing user JWT" }, 401);

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "Invalid session" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { action, restaurantId } = body ?? {};
  if (!action || !restaurantId) return json({ error: "action and restaurantId required" }, 400);

  // Confirma que o usuário tem acesso ao restaurante (RLS aplica via userClient)
  const { data: integration, error: intErr } = await userClient
    .from("ihub_integrations")
    .select("*")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (intErr) return json({ error: intErr.message }, 403);
  if (!integration) return json({ error: "Configure o token e domínio antes." }, 400);

  const token = String(integration.secret_token ?? "").trim();
  const domain = String(integration.domain ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!token) return json({ ok: false, error: "Token secreto do iHub não configurado" }, 400);
  if (!domain) return json({ ok: false, error: "Domínio do iHub não configurado" }, 400);

  try {
    if (action === "generate-user-code") {
      const r = await callIhub({ method: "POST", path: "/auth/generate-user-code", token });
      if (!r.ok) return json({ ok: false, status: r.status, error: ihubErrorMessage(r.data, "Falha no iHub"), data: r.data });
      const d = pickIhubData(r.data) ?? {};
      const userCode = d.userCode ?? d.user_code;
      const authorizationCodeVerifier = d.authorizationCodeVerifier ?? d.authorization_code_verifier;
      if (!userCode || !authorizationCodeVerifier) {
        return json({ ok: false, status: r.status, error: "Resposta inesperada do iHub", data: d });
      }
      return json({
        ok: true,
        userCode,
        authorizationCodeVerifier,
        verificationUrl: d.verificationUrl,
        verificationUrlComplete: d.verificationUrlComplete,
      });
    }

    if (action === "link-merchant") {
      const { authorizationCode, authorizationCodeVerifier } = body;
      if (!authorizationCode || !authorizationCodeVerifier) {
        return json({ ok: false, error: "authorizationCode e authorizationCodeVerifier são obrigatórios" }, 400);
      }
      const r = await callIhub({
        method: "POST",
        path: "/auth/link-merchant",
        token,
        body: { domain, authorizationCode, authorizationCodeVerifier },
      });
      if (!r.ok) return json({ ok: false, status: r.status, error: ihubErrorMessage(r.data, "Falha ao vincular merchant"), data: r.data });
      const d = pickIhubData(r.data) ?? {};
      const merchant = d.merchant ?? {};
      const details = d.ifood_details ?? d.ifoodDetails ?? {};
      const merchantId = merchant.merchant_id ?? merchant.merchantId ?? details.id ?? d.merchantId ?? null;
      const merchantName = details.name ?? merchant.name ?? d.merchantName ?? null;

      if (merchantId) {
        await admin
          .from("ihub_integrations")
          .update({ merchant_id: merchantId, merchant_name: merchantName })
          .eq("id", integration.id);
      }
      return json({ ok: true, merchantId, merchantName, raw: r.data });
    }

    if (action === "order-action") {
      const { merchantId, orderId, ifoodAction, cancelCode, cancelReason, disputeId, reason, detailReason, alternativeId, refundAmount } = body;
      if (!merchantId || !orderId || !ifoodAction) {
        return json({ ok: false, error: "merchantId, orderId e ifoodAction são obrigatórios" }, 400);
      }
      const payload: Record<string, unknown> = { domain, merchantId, orderId, action: ifoodAction };
      if (cancelCode) payload.cancelCode = cancelCode;
      if (cancelReason) payload.cancelReason = cancelReason;
      if (disputeId) payload.disputeId = disputeId;
      if (reason) payload.reason = reason;
      if (detailReason) payload.detailReason = detailReason;
      if (alternativeId) payload.alternativeId = alternativeId;
      if (refundAmount) payload.refundAmount = refundAmount;

      const r = await callIhub({ method: "POST", path: "/ifood/action", token, body: payload });
      return json({ ok: r.ok, status: r.status, data: r.data, error: r.ok ? null : ihubErrorMessage(r.data, "Falha na ação") });
    }

    if (action === "order-details") {
      const { merchantId, orderId } = body;
      if (!merchantId || !orderId) return json({ ok: false, error: "merchantId e orderId são obrigatórios" }, 400);
      const r = await callIhub({ method: "GET", path: `/orders/${merchantId}/${orderId}`, token });
      return json({ ok: r.ok, status: r.status, data: r.data, error: r.ok ? null : ihubErrorMessage(r.data, "Falha ao buscar pedido") });
    }

    if (action === "cancellation-reasons") {
      const { merchantId, orderId } = body;
      if (!merchantId || !orderId) return json({ ok: false, error: "merchantId e orderId são obrigatórios" }, 400);
      const r = await callIhub({ method: "GET", path: `/orders/${merchantId}/${orderId}/cancellation-reasons`, token });
      return json({ ok: r.ok, status: r.status, data: r.data, error: r.ok ? null : ihubErrorMessage(r.data, "Falha ao buscar motivos") });
    }

    return json({ ok: false, error: `Ação desconhecida: ${action}` }, 400);
  } catch (e: any) {
    console.error("ihub-api error", e);
    return json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});
