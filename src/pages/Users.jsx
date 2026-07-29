import { useEffect, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Loader2, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react';

function authHeaders() {
  const token = localStorage.getItem('base44_access_token') || '';
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export default function Users() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });

  useEffect(() => {
    fetch('/api/auth/profile', { headers: authHeaders() })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Não foi possível carregar o usuário.');
        setProfile(data);
      })
      .catch((error) => setMessage({ type: 'error', text: error.message }))
      .finally(() => setLoading(false));
  }, []);

  const changePassword = async (event) => {
    event.preventDefault();
    setMessage(null);
    if (form.newPassword !== form.confirmPassword) {
      setMessage({ type: 'error', text: 'A confirmação não corresponde à nova senha.' });
      return;
    }
    if (form.newPassword.length < 10) {
      setMessage({ type: 'error', text: 'A nova senha deve ter pelo menos 10 caracteres.' });
      return;
    }
    setSaving(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          current_password: form.currentPassword,
          new_password: form.newPassword,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível alterar a senha.');
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setMessage({ type: 'success', text: data.message || 'Senha alterada com sucesso.' });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full rounded-lg border border-surface-3 bg-surface-2 px-3 py-2.5 pr-10 text-sm text-slate-100 outline-none transition-colors focus:border-cyan/60';

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <UserRound className="w-5 h-5 text-cyan" /> Usuários
        </h1>
        <p className="text-xs text-slate-500 mt-1">Perfil administrativo e segurança de acesso.</p>
      </div>

      <section className="rounded-xl border border-surface-2 bg-surface-1 p-5">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-slate-200">Administrador</h2>
        </div>
        {loading ? (
          <Loader2 className="w-5 h-5 text-cyan animate-spin" />
        ) : profile ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-surface-2 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Nome</p>
              <p className="text-sm text-slate-200 mt-1">{profile.full_name}</p>
            </div>
            <div className="rounded-lg bg-surface-2 p-3 sm:col-span-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">E-mail</p>
              <p className="text-sm text-slate-200 mt-1">{profile.email}</p>
            </div>
            <div className="rounded-lg bg-surface-2 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Perfil</p>
              <p className="text-sm text-emerald-400 mt-1">Administrador</p>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-surface-2 bg-surface-1 p-5">
        <div className="flex items-center gap-2 mb-1">
          <LockKeyhole className="w-4 h-4 text-cyan" />
          <h2 className="text-sm font-semibold text-slate-200">Trocar senha</h2>
        </div>
        <p className="text-xs text-slate-500 mb-5">Informe a senha atual antes de definir uma nova senha.</p>

        {message && (
          <div className={`mb-4 rounded-lg border px-3 py-2.5 text-xs ${
            message.type === 'success'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/30 bg-red-500/10 text-red-300'
          }`}>
            {message.text}
          </div>
        )}

        <form onSubmit={changePassword} className="max-w-lg space-y-4">
          {[
            ['currentPassword', 'Senha atual', 'current-password'],
            ['newPassword', 'Nova senha', 'new-password'],
            ['confirmPassword', 'Confirmar nova senha', 'new-password'],
          ].map(([key, label, autoComplete]) => (
            <label key={key} className="block">
              <span className="block text-xs text-slate-400 mb-1.5">{label}</span>
              <div className="relative">
                <input
                  type={showPasswords ? 'text' : 'password'}
                  autoComplete={autoComplete}
                  value={form[key]}
                  onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
                  className={inputClass}
                  required
                  minLength={key === 'currentPassword' ? undefined : 10}
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords((current) => !current)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                  aria-label={showPasswords ? 'Ocultar senhas' : 'Mostrar senhas'}
                >
                  {showPasswords ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </label>
          ))}
          <p className="text-[10px] text-slate-500">Use pelo menos 10 caracteres. A senha nunca é armazenada em texto aberto.</p>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan px-4 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-60"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {saving ? 'Alterando…' : 'Alterar senha'}
          </button>
        </form>
      </section>
    </div>
  );
}
