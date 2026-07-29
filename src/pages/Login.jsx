import React, { useRef, useState } from "react";
import { Lock, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Login() {
  const openingAudioRef = useRef(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const playOpeningAudio = async () => {
    const audio = openingAudioRef.current;
    if (!audio) return;
    try {
      audio.currentTime = 0;
      await audio.play();
      await Promise.race([
        new Promise((resolve) => audio.addEventListener("ended", resolve, { once: true })),
        new Promise((resolve) => setTimeout(resolve, 3800)),
      ]);
    } catch {
      // Alguns navegadores bloqueiam reprodução automática. O áudio é um
      // complemento da entrada e nunca deve impedir ou atrasar o acesso.
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        throw new Error(data.error || "Senha incorreta");
      }
      localStorage.setItem("base44_access_token", data.token);
      await playOpeningAudio();
      window.location.href = data.user?.must_change_password
        ? "/users?change_password=1"
        : "/";
    } catch (err) {
      setError(err.message || "Erro ao autenticar");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas px-4">
      <audio
        ref={openingAudioRef}
        src="/abertura-app-ia-3s.wav"
        preload="auto"
        aria-hidden="true"
      />
      <div className="w-full max-w-sm">
        {/* Logo / cabeçalho */}
        <div className="flex flex-col items-center mb-8">
          <img
            src="/logo.jpg"
            alt="Living Finds"
            className="w-44 rounded-2xl shadow-sm mb-4"
          />
          <p className="text-sm text-muted-foreground">Painel Ads · Acesso restrito</p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">E-mail</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  placeholder="seu@email.com.br"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10 h-12"
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Senha de acesso</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-10 h-12"
                  required
                />
              </div>
            </div>
            <Button type="submit" className="w-full h-12 font-medium" disabled={loading}>
              {loading
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Entrando...</>
                : "Entrar"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
