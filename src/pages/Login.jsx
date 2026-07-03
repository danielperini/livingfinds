import React, { useState } from "react";
import { Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LogIn, Mail, Lock, Loader2 } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import GoogleIcon from "@/components/GoogleIcon";
import { isAllowedEmail, EMAIL_DOMAIN_ERROR } from "@/lib/allowedEmailDomains";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (!isAllowedEmail(email)) {
      setError(EMAIL_DOMAIN_ERROR);
      return;
    }

    setLoading(true);
    try {
      await base44.auth.loginViaEmailPassword(email.trim().toLowerCase(), password);
      const currentUser = await base44.auth.me();
      if (!isAllowedEmail(currentUser?.email)) {
        await base44.auth.logout();
        throw new Error(EMAIL_DOMAIN_ERROR);
      }
      const urlParams = new URLSearchParams(window.location.search);
      const next = urlParams.get("next");
      window.location.href = next || "/";
    } catch (err) {
      setError(err.message || "E-mail ou senha inválidos");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const next = urlParams.get("next") || "/";
    base44.auth.loginWithProvider("google", next);
  };

  return (
    <AuthLayout
      icon={LogIn}
      title="Acessar o Living Finds"
      subtitle="Somente contas corporativas autorizadas"
      footer={
        <>
          Precisa de uma conta?{" "}
          <Link to="/register" className="text-primary font-medium hover:underline">
            Criar conta
          </Link>
        </>
      }
    >
      <Button variant="outline" className="w-full h-12 text-sm font-medium mb-4" onClick={handleGoogle}>
        <GoogleIcon className="w-5 h-5 mr-2" />
        Continuar com Google
      </Button>

      <p className="mb-6 text-center text-xs text-muted-foreground">
        Permitidos: @periniprojetos.com.br e @livingfinds.com.br
      </p>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">E-mail</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="nome@livingfinds.com.br"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pl-10 h-12"
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Senha</Label>
            <Link to="/forgot-password" className="text-xs text-primary hover:underline">Esqueci a senha</Link>
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pl-10 h-12"
              required
            />
          </div>
        </div>
        <Button type="submit" className="w-full h-12 font-medium" disabled={loading}>
          {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Entrando...</> : "Entrar"}
        </Button>
      </form>
    </AuthLayout>
  );
}
