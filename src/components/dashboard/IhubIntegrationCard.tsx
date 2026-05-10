import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, Copy, Utensils, Link2, ExternalLink } from "lucide-react";
import { toast } from "sonner";

const sb = supabase as any;
const WEBHOOK_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ihub-webhook`;

export function IhubIntegrationCard({ restaurantId }: { restaurantId: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["ihub-integration", restaurantId],
    queryFn: async () => {
      const { data } = await sb
        .from("ihub_integrations")
        .select("*")
        .eq("restaurant_id", restaurantId)
        .maybeSingle();
      return data ?? null;
    },
  });

  const [token, setToken] = useState("");
  const [domain, setDomain] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(false);
  const [userCodeData, setUserCodeData] = useState<any>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState("");

  const handleGenerateUserCode = async () => {
    if (!data?.secret_token) {
      toast.error("Salve o token primeiro");
      return;
    }
    setLinking(true);
    setLinkError(null);
    try {
      const { data: res, error } = await supabase.functions.invoke("ihub-link", {
        body: { action: "generate-user-code", restaurantId },
      });
      if (error) throw error;
      if (!res?.ok || !res?.userCode || !res?.authorizationCodeVerifier) {
        const details = res?.data?.raw || res?.data?.message || res?.error || "Falha ao gerar código";
        throw new Error(String(details));
      }
      setUserCodeData(res);
      toast.success("Código gerado! Autorize no portal do iFood.");
    } catch (e: any) {
      const message = e.message ?? "Erro ao gerar User Code";
      setLinkError(message);
      toast.error(message);
    } finally {
      setLinking(false);
    }
  };

  const handleLinkMerchant = async () => {
    if (!authCode.trim() || !userCodeData?.authorizationCodeVerifier) {
      toast.error("Cole o authorizationCode retornado pelo iFood");
      return;
    }
    setLinking(true);
    try {
      const { data: res, error } = await supabase.functions.invoke("ihub-link", {
        body: {
          action: "link-merchant",
          restaurantId,
          authorizationCode: authCode.trim(),
          authorizationCodeVerifier: userCodeData.authorizationCodeVerifier,
        },
      });
      if (error) throw error;
      if (!res?.ok) throw new Error(res?.error || "Falha ao vincular");
      toast.success(`Loja vinculada: ${res.merchantName ?? res.merchantId}`);
      setUserCodeData(null);
      setAuthCode("");
      qc.invalidateQueries({ queryKey: ["ihub-integration", restaurantId] });
    } catch (e: any) {
      toast.error(e.message ?? "Erro");
    } finally {
      setLinking(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setToken(data?.secret_token ?? "");
    setDomain(data?.domain ?? "");
    setMerchantId(data?.merchant_id ?? "");
    setEnabled(data?.enabled ?? true);
  }, [open, data]);

  const isConfigured = !!data?.secret_token;

  const copy = async (text: string, label: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast.success(`${label} copiado`);
    } catch {
      toast.error("Não foi possível copiar — copie manualmente");
    }
  };

  const handleSave = async () => {
    if (!token.trim()) {
      toast.error("Cole o token secreto do iHub");
      return;
    }
    if (!domain.trim()) {
      toast.error("Informe o domínio do seu sistema (mesmo cadastrado no painel iHub)");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        restaurant_id: restaurantId,
        secret_token: token.trim(),
        domain: domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
        merchant_id: merchantId.trim() || null,
        enabled,
      };
      const { error } = await sb
        .from("ihub_integrations")
        .upsert(payload, { onConflict: "restaurant_id" });
      if (error) throw error;
      toast.success("Integração iHub salva");
      qc.invalidateQueries({ queryKey: ["ihub-integration", restaurantId] });
      setOpen(false);
    } catch (e: any) {
      toast.error(e.message ?? "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setOpen(true)}>
        <CardHeader className="flex flex-row items-center gap-3 pb-2">
          <div className="w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center">
            <Utensils className="w-6 h-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base">iHub (iFood)</CardTitle>
            <CardDescription className="text-xs">Receber pedidos do iFood via iHub</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : isConfigured ? (
            <Badge variant={data?.enabled ? "default" : "secondary"}>
              {data?.enabled ? "Conectado" : "Desativado"}
            </Badge>
          ) : (
            <Badge variant="outline">Não configurado</Badge>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Integração iHub (iFood)</DialogTitle>
            <DialogDescription>
              Configure o webhook, token e domínio do seu sistema. Depois gere o User Code e cole o código de autorização do iFood para vincular a loja.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Step 1 — Webhook URL */}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">1</span>
                <Label className="font-semibold">URL do Webhook</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Cole esta URL no campo <strong>"URL de webhook"</strong> do painel iHub.
              </p>
              <div className="flex gap-2">
                <Input value={WEBHOOK_URL} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={() => copy(WEBHOOK_URL, "URL")}>
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Step 2 — Token + Domain */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">2</span>
                <Label className="font-semibold">Credenciais do iHub</Label>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Token Secreto</Label>
                <Input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="UUID exibido no painel iHub após salvar as configurações"
                  type="password"
                />
                <p className="text-xs text-muted-foreground">
                  Mesmo token para todos os seus restaurantes. É enviado no header <code>X-iFood-Hub-Signature</code>.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Domínio do seu sistema</Label>
                <Input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="Ex: app.meudelivery.com.br"
                />
                <p className="text-xs text-muted-foreground">
                  Deve ser <strong>exatamente</strong> o mesmo domínio cadastrado no painel iHub. O iHub valida esse campo ao vincular merchants.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-md border p-2">
                <div>
                  <Label className="cursor-pointer text-sm">Integração ativa</Label>
                  <p className="text-xs text-muted-foreground">Importar pedidos automaticamente</p>
                </div>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </div>

            {/* Step 3 — Link merchant */}
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">3</span>
                <Label className="font-semibold">Vincular loja iFood</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Salve as credenciais primeiro. Depois clique em <strong>Gerar User Code</strong>, abra o portal iFood, autorize, e cole aqui o <code>authorizationCode</code> retornado pelo iFood.
              </p>

              {!userCodeData ? (
                <div className="space-y-2">
                  <Button type="button" variant="outline" size="sm" onClick={handleGenerateUserCode} disabled={linking || !isConfigured}>
                    {linking ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Link2 className="w-4 h-4 mr-1" />}
                    Gerar User Code
                  </Button>
                  {linkError && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive break-words">
                      {linkError}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="rounded bg-muted p-2 text-xs space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>User Code:</strong>
                      <code className="px-1.5 py-0.5 bg-background rounded">{userCodeData.userCode}</code>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copy(userCodeData.userCode, "User Code")}>
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <strong>Authorization Code Verifier:</strong>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copy(userCodeData.authorizationCodeVerifier, "Authorization Code Verifier")}>
                          <Copy className="w-3 h-3" />
                        </Button>
                      </div>
                      <code className="block rounded bg-background px-1.5 py-1 break-all">{userCodeData.authorizationCodeVerifier}</code>
                    </div>
                    {userCodeData.verificationUrlComplete && (
                      <a href={userCodeData.verificationUrlComplete} target="_blank" rel="noreferrer"
                         className="inline-flex items-center gap-1 text-primary underline">
                        Abrir portal iFood <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                  <Label className="text-xs">Código de autorização (authorizationCode)</Label>
                  <Input
                    value={authCode}
                    onChange={(e) => setAuthCode(e.target.value)}
                    placeholder="Cole aqui o código retornado pelo iFood"
                  />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={handleLinkMerchant} disabled={linking}>
                      {linking ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <CheckCircle2 className="w-4 h-4 mr-1" />}
                      Vincular merchant
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => { setUserCodeData(null); setAuthCode(""); }}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              )}

              {data?.merchant_id && (
                <div className="rounded bg-muted p-2 text-xs">
                  <div><strong>Merchant vinculado:</strong></div>
                  <div className="font-mono break-all">{data.merchant_id}</div>
                  {data.merchant_name && <div className="text-muted-foreground">{data.merchant_name}</div>}
                </div>
              )}
            </div>

            {/* Optional manual merchant id */}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Merchant ID manual (avançado)</summary>
              <div className="mt-2 space-y-1">
                <Input
                  value={merchantId}
                  onChange={(e) => setMerchantId(e.target.value)}
                  placeholder="Preencha apenas se já tiver o merchant ID do iFood"
                />
                <p className="text-muted-foreground">
                  Use o fluxo acima (User Code) para vincular automaticamente. Preencha aqui só se já souber o ID.
                </p>
              </div>
            </details>

            {data?.last_event_at && (
              <p className="text-xs text-muted-foreground">
                Último evento: {new Date(data.last_event_at).toLocaleString("pt-BR")}
                {data.last_event_code ? ` — ${data.last_event_code}` : ""}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
