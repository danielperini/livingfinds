import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Eye, EyeOff, Loader2, LockKeyhole, Plus, ShieldCheck, UserRound, X } from 'lucide-react';

function authHeaders() {
  const token = localStorage.getItem('base44_access_token') || '';
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export default function Users() {
  const [profile, setProfile] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newUser, setNewUser] = useState({ fullName: '', email: '' });
  const [createdAccess, setCreatedAccess] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/auth/profile', { headers: authHeaders() }),
      fetch('/api/auth/users', { headers: authHeaders() }),
    ])
      .then(async ([profileResponse, usersResponse]) => {
        const [profileData, usersData] = await Promise.all([profileResponse.json(), usersResponse.json()]);
        if (!profileResponse.ok) throw new Error(profileData.error || 'Não foi possível carregar o usuário.');
        if (!usersResponse.ok) throw new Error(usersData.error || 'Não foi possível carregar os usuários.');
        setProfile(profileData);
        setUsers(usersData.users || []);
      })
      .catch((error) => setMessage({ type: 'error', text: error.message }))
      .finally(() => setLoading(false));
  }, []);

  const createUser = async (event) => {
    event.preventDefault();
    setMessage(null);
    setCreating(true);
    try {
      const response = await fetch('/api/auth/users', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ full_name: newUser.fullName, email: newUser.email }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível criar o usuário.');
      setUsers((current) => [...current, data.user]);
      setCreatedAccess({ ...data.user, password: data.initial_password });
      setNewUser({ fullName: '', email: '' });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setCreating(false);
    }
  };

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
      if (new URLSearchParams(window.location.search).get('change_password') === '1') {
        window.setTimeout(() => { window.location.href = '/'; }, 700);
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full rounded-lg border border-surface-3 bg-surface-2 px-3 py-2.5 pr-10 text-sm text-slate-100 outline-none transition-colors focus:border-cyan/60';

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <UserRound className="w-5 h-5 text-cyan" /> Usuários
          </h1>
          <p className="text-xs text-slate-500 mt-1">Perfis administrativos e segurança de acesso.</p>
        </div>
        <button
          type="button"
          onClick={() => { setCreateOpen(true); setCreatedAccess(null); }}
          className="inline-flex items-center gap-2 rounded-lg bg-cyan px-4 py-2.5 text-sm font-semibold text-white"
        >
          <Plus className="w-4 h-4" /> Criar novo usuário
        </button>
      </div>

      <section className="rounded-xl border border-surface-2 bg-surface-1 p-5">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-slate-200">Administradores</h2>
        </div>
        {loading ? (
          <Loader2 className="w-5 h-5 text-cyan animate-spin" />
        ) : users.length ? (
          <div className="space-y-2">
            {users.map((user) => (
              <div key={user.id} className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto] items-center rounded-lg bg-surface-2 px-4 py-3">
                <div><p className="text-[9px] uppercase text-slate-600">Nome</p><p className="text-sm text-slate-200">{user.full_name}</p></div>
                <div><p className="text-[9px] uppercase text-slate-600">E-mail</p><p className="text-sm text-slate-300">{user.email}</p></div>
                <span className="w-fit rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-400">Administrador</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {createOpen && (
        <div className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-surface-3 bg-surface-1 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3 mb-5">
              <div><h2 className="text-base font-semibold text-white">Novo usuário</h2><p className="text-xs text-slate-500 mt-1">Todo novo perfil será administrador.</p></div>
              <button type="button" onClick={() => setCreateOpen(false)} className="text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            {createdAccess ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
                  <p className="text-sm font-semibold text-emerald-300">Usuário criado com sucesso</p>
                  <p className="text-xs text-slate-400 mt-2">E-mail: <strong className="text-slate-200">{createdAccess.email}</strong></p>
                  <div className="mt-3 rounded-lg bg-surface-3 p-3 flex items-center justify-between gap-3">
                    <div><p className="text-[9px] uppercase text-slate-500">Senha inicial</p><code className="text-sm text-amber-300">{createdAccess.password}</code></div>
                    <button type="button" onClick={() => navigator.clipboard.writeText(createdAccess.password)} className="text-slate-400 hover:text-white" aria-label="Copiar senha"><Copy className="w-4 h-4" /></button>
                  </div>
                  <p className="text-[10px] text-amber-300/80 mt-2">Envie essa senha ao usuário. Ele deverá alterá-la após entrar.</p>
                </div>
                <button type="button" onClick={() => setCreateOpen(false)} className="w-full rounded-lg bg-cyan py-2.5 text-sm font-semibold text-white">Concluir</button>
              </div>
            ) : (
              <form onSubmit={createUser} className="space-y-4">
                <label className="block"><span className="block text-xs text-slate-400 mb-1.5">Nome</span><input value={newUser.fullName} onChange={(event) => setNewUser((current) => ({ ...current, fullName: event.target.value }))} className={inputClass.replace('pr-10', '')} required /></label>
                <label className="block"><span className="block text-xs text-slate-400 mb-1.5">E-mail</span><input type="email" value={newUser.email} onChange={(event) => setNewUser((current) => ({ ...current, email: event.target.value }))} className={inputClass.replace('pr-10', '')} required /></label>
                <div className="rounded-lg bg-surface-2 border border-surface-3 p-3 text-xs text-slate-400">
                  Senha inicial automática: <strong className="text-amber-300">{newUser.fullName.trim().split(/\s+/)[0] || 'Nome'}@12345</strong>
                </div>
                <button type="submit" disabled={creating} className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-cyan py-2.5 text-sm font-semibold text-white disabled:opacity-60">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}{creating ? 'Criando…' : 'Criar usuário'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      <section className="rounded-xl border border-surface-2 bg-surface-1 p-5">
        <div className="flex items-center gap-2 mb-1">
          <LockKeyhole className="w-4 h-4 text-cyan" />
          <h2 className="text-sm font-semibold text-slate-200">Trocar senha</h2>
        </div>
        <p className="text-xs text-slate-500 mb-5">
          {profile ? `${profile.full_name}: informe sua senha atual antes de definir uma nova senha.` : 'Informe a senha atual antes de definir uma nova senha.'}
        </p>

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
