// iHub merchant linking helper
// Actions: generate-user-code, link-merchant
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// iHub API base URL is fixed; the `domain` stored on the integration is the
// user's OWN system domain (e.g. "app.meudelivery.com.br"), used as a payload
// field on link-merchant / action endpoints, NOT as the API host.
const IHUB_BASE_URL = "https://ihub.arcn.com.br/api";

function normalizeUserDomain(domain: string | null | undefined) {
  return (domain || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const token0 = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: claimsRes, error: userErr } = await supabase.auth.getClaims(token0);
  const userId = claimsRes?.claims?.sub;
  if (userErr || !userId) {
    console.error("auth getClaims error:", userErr);
    return new Response(JSON.stringify({ error: "Unauthorized", details: userErr?.message }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { action, restaurantId, authorizationCode, authorizationCodeVerifier } = body;
  if (!action || !restaurantId) {
    return new Response(JSON.stringify({ error: "Missing action or restaurantId" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: integration } = await supabase
    .from("ihub_integrations")
    .select("*")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (!integration?.secret_token) {
    return new Response(JSON.stringify({ error: "Token iHub não configurado para este restaurante" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const base = IHUB_BASE_URL;
  const userDomain = normalizeUserDomain(integration.domain);
  const token = integration.secret_token;

  if (!userDomain) {
    return new Response(JSON.stringify({ error: "Domínio do sistema não configurado. Cadastre o mesmo domínio que está no painel iHub." }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    if (action === "generate-user-code") {
      const url = `${base}/auth/generate-user-code`;
      console.log("[ihub-link] generate-user-code →", url);
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
      });
      const text = await r.text();
      const ct = r.headers.get("content-type") || "";
      let data: any;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
      if (!r.ok || !ct.includes("json") || !data?.userCode) {
        return new Response(JSON.stringify({
          error: "Resposta inválida do iHub. Verifique se o token está correto e se a integração foi salva.",
          status: r.status,
          contentType: ct,
          data,
          calledUrl: url,
        }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, ...data }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "link-merchant") {
      if (!authorizationCode || !authorizationCodeVerifier) {
        return new Response(JSON.stringify({ error: "authorizationCode e authorizationCodeVerifier são obrigatórios" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const r = await fetch(`${base}/auth/link-merchant`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          domain: userDomain,
          authorizationCode,
          authorizationCodeVerifier,
        }),
      });
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!r.ok) {
        return new Response(JSON.stringify({ error: "iHub error", status: r.status, data }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Auto-save merchant_id
      const merchantId = data?.merchant?.merchant_id ?? data?.ifood_details?.id ?? null;
      const merchantName = data?.ifood_details?.name ?? null;
      if (merchantId) {
        await supabase
          .from("ihub_integrations")
          .update({ merchant_id: merchantId, merchant_name: merchantName })
          .eq("id", integration.id);
      }
      return new Response(JSON.stringify({ ok: true, merchantId, merchantName, ...data }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
