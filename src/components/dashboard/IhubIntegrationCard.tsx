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
import { Loader2, CheckCircle2, Copy, Utensils, Link2, ExternalLink, Trash2 } from "lucide-react";
import { toast } from "sonner";

const sb = supabase as any;
const WEBHOOK_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ihub-webhook`;
const DEFAULT_DOMAIN = "app.coxinhasurprise.com.br";

type UserCodeResp = {
  userCode: string;
  authorizationCodeVerifier: string;
  verificationUrl?: string;
  verificationUrlComplete?: string;
};

export function IhubIntegrationCard({ restaurantId }: { restaurantId: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
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
  const [domain, setDomain] = useState(DEFAULT_DOMAIN);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(false);
  const [userCodeData, setUserCodeData] = useState<UserCodeResp | null>(null);
  const [authCode, setAuthCode] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setToken(data?.secret_token ?? "");
    setDomain(data?.domain ?? DEFAULT_DOMAIN);
    setEnabled(data?.enabled ?? true);
    setUserCodeData(null);
    setAuthCode("");
    setLinkError(null);
  }, [open, data]);

  const isConfigured = !!data?.secret_token && !!data?.domain;
  const isLinked = !!data?.merchant_id;

  const copy = async (text: string, label: string) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select(); document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast.success(`${label} copiado`);
    } catch { toast.error("Não foi possível copiar"); }
  };

  const handleSave = async () => {
    if (!token.trim()) return toast.error("Cole o token secreto do iHub");
    if (!domain.trim()) return toast.error("Informe o domínio cadastrado no painel iHub");
    setSaving(true);
    try {
      const payload = {
        restaurant_id: restaurantId,
        secret_token: token.trim(),
        domain: domain.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, ""),
        enabled,
      };
      const { error } = await sb
        .from("ihub_integrations")
        .upsert(payload, { onConflict: "restaurant_id" });
      if (error) throw error;
      toast.success("Credenciais salvas");
      qc.invalidateQueries({ queryKey: ["ihub-integration", restaurantId] });
      await refetch();
    } catch (e: any) {
      toast.error(e.message ?? "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateUserCode = async () => {
    if (!isConfigured) return toast.error("Salve o token e domínio primeiro");
    setLinking(true);
    setLinkError(null);
    try {
      const { data: res, error } = await supabase.functions.invoke("ihub-api", {
        body: { action: "generate-user-code", restaurantId },
      });
      if (error) throw error;
      if (!res?.ok) {
        const msg = res?.error || res?.data?.message || "Falha ao gerar User Code";
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      setUserCodeData({
        userCode: res.userCode,
        authorizationCodeVerifier: res.authorizationCodeVerifier,
        verificationUrl: res.verificationUrl,
        verificationUrlComplete: res.verificationUrlComplete,
      });
      toast.success("User Code gerado. Autorize no portal do iFood.");
    } catch (e: any) {
      const m = e.message ?? "Erro ao gerar User Code";
      setLinkError(m);
      toast.error(m);
    } finally {
      setLinking(false);
    }
  };

  const handleLinkMerchant = async () => {
    if (!userCodeData) return;
    if (!authCode.trim()) return toast.error("Cole o authorizationCode retornado pelo iFood");
    setLinking(true);
    setLinkError(null);
    try {
      const { data: res, error } = await supabase.functions.invoke("ihub-api", {
        body: {
          action: "link-merchant",
          restaurantId,
          authorizationCode: authCode.trim(),
          authorizationCodeVerifier: userCodeData.authorizationCodeVerifier,
        },
      });
      if (error) throw error;
      if (!res?.ok) {
        const msg = res?.error || res?.data?.message || "Falha ao vincular merchant";
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      toast.success(`Loja vinculada: ${res.merchantName ?? res.merchantId ?? "ok"}`);
      setUserCodeData(null);
      setAuthCode("");
      qc.invalidateQueries({ queryKey: ["ihub-integration", restaurantId] });
    } catch (e: any) {
      const m = e.message ?? "Erro ao vincular";
      setLinkError(m);
      toast.error(m);
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async () => {
    if (!confirm("Desvincular a loja iFood deste restaurante?")) return;
    const { error } = await sb
      .from("ihub_integrations")
      .update({ merchant_id: null, merchant_name: null })
      .eq("restaurant_id", restaurantId);
    if (error) return toast.error(error.message);
    toast.success("Loja desvinculada");
    qc.invalidateQueries({ queryKey: ["ihub-integration", restaurantId] });
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
          ) : isLinked && data?.enabled ? (
            <Badge variant="default">Conectado</Badge>
          ) : isConfigured ? (
            <Badge variant="secondary">Aguardando vinculação</Badge>
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
              Siga os 4 passos para conectar uma loja iFood usando o iHub.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Step 1 — Webhook URL */}
            <div className="space-y-2 rounded-md border p-3">
              <StepHeader n={1} title="URL do Webhook" />
              <p className="text-xs text-muted-foreground">
                Cole esta URL no campo <strong>"URL de webhook"</strong> do painel iHub e salve.
              </p>
              <div className="flex gap-2">
                <Input value={WEBHOOK_URL} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={() => copy(WEBHOOK_URL, "URL")}>
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Step 2 — Domínio */}
            <div className="space-y-2 rounded-md border p-3">
              <StepHeader n={2} title="Domínio" />
              <p className="text-xs text-muted-foreground">
                Use o mesmo domínio cadastrado no painel iHub. O iHub valida esse campo em todas as requisições.
              </p>
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={DEFAULT_DOMAIN} />
            </div>

            {/* Step 3 — Token */}
            <div className="space-y-2 rounded-md border p-3">
              <StepHeader n={3} title="Token Secreto" />
              <p className="text-xs text-muted-foreground">
                UUID exibido no painel iHub após salvar as configurações. Usado nas chamadas à API e validado em cada webhook.
              </p>
              <Input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="UUID exibido no painel iHub"
                type="password"
              />
              <div className="flex items-center justify-between rounded-md border p-2">
                <Label className="text-sm">Integração ativa</Label>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <CheckCircle2 className="w-4 h-4 mr-1" />}
                Salvar credenciais
              </Button>
            </div>

            {/* Step 4 — Vincular merchant */}
            <div className="space-y-3 rounded-md border p-3">
              <StepHeader n={4} title="Vincular loja iFood" />
              {!isConfigured ? (
                <p className="text-xs text-muted-foreground">Salve o token e domínio acima para liberar este passo.</p>
              ) : isLinked ? (
                <div className="space-y-2">
                  <div className="rounded bg-muted p-2 text-xs">
                    <div><strong>Merchant vinculado:</strong></div>
                    <div className="font-mono break-all">{data.merchant_id}</div>
                    {data.merchant_name && <div className="text-muted-foreground">{data.merchant_name}</div>}
                  </div>
                  <Button variant="outline" size="sm" onClick={handleUnlink}>
                    <Trash2 className="w-4 h-4 mr-1" /> Desvincular
                  </Button>
                </div>
              ) : !userCodeData ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Gere um User Code, autorize no portal iFood e cole o <code>authorizationCode</code> retornado.
                  </p>
                  <Button size="sm" variant="outline" onClick={handleGenerateUserCode} disabled={linking}>
                    {linking ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Link2 className="w-4 h-4 mr-1" />}
                    Gerar User Code
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="rounded bg-muted p-2 text-xs space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>User Code:</strong>
                      <code className="px-1.5 py-0.5 bg-background rounded text-sm font-bold tracking-wider">{userCodeData.userCode}</code>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copy(userCodeData.userCode, "User Code")}>
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <strong>Authorization Code Verifier:</strong>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copy(userCodeData.authorizationCodeVerifier, "Verifier")}>
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
                  <Label className="text-xs">Authorization Code (retornado pelo iFood)</Label>
                  <Input value={authCode} onChange={(e) => setAuthCode(e.target.value)} placeholder="Cole o código aqui" />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleLinkMerchant} disabled={linking}>
                      {linking ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <CheckCircle2 className="w-4 h-4 mr-1" />}
                      Vincular merchant
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setUserCodeData(null); setAuthCode(""); }}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              )}

              {linkError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive break-words">
                  {linkError}
                </div>
              )}
            </div>

            {data?.last_event_at && (
              <p className="text-xs text-muted-foreground">
                Último evento: {new Date(data.last_event_at).toLocaleString("pt-BR")}
                {data.last_event_code ? ` — ${data.last_event_code}` : ""}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StepHeader({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">{n}</span>
      <Label className="font-semibold">{title}</Label>
    </div>
  );
}
