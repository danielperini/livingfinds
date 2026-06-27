import { useState } from 'react';
import { Zap, Eye, EyeOff, Loader2 } from 'lucide-react';
import { xanoAuth, setXanoToken } from '@/lib/xanoClient';

export default function XanoLogin({ onSuccess }) {
  const [mode, setMode] = useState('login'); // login | signup
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handle = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      let data;
      if (mode === 'login') {
        data = await xanoAuth.login(form.email, form.password);
      } else {
        data = await xanoAuth.signup(form.name, form.email, form.password);
      }
      if (data.authToken) {
        setXanoToken(data.authToken);
        onSuccess?.();
      } else {
        throw { message: 'Token não recebido. Verifica as credenciais.' };
      }
    } catch (err) {
      setError(err.message || 'Erro de autenticação');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 rounded-xl bg-cyan flex items-center justify-center">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <span className="font-heading font-bold text-white text-xl">LivingFinds</span>
        </div>

        <div className="bg-surface-1 border border-surface-2 rounded-2xl p-8">
          <h1 className="text-lg font-bold text-white mb-1">
            {mode === 'login' ? 'Iniciar sessão' : 'Criar conta'}
          </h1>
          <p className="text-sm text-slate-400 mb-6">Amazon Ads Automation Platform</p>

          <form onSubmit={handle} className="space-y-4">
            {mode === 'signup' && (
              <div>
                <label className="block text-xs text-slate-400 mb-1.5">Nome</label>
                <input
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="O teu nome"
                  required
                  className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50 transition-colors"
                />
              </div>
            )}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                placeholder="email@exemplo.com"
                required
                className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={form.password}
                  onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                  placeholder="••••••••"
                  required
                  className="w-full px-3 py-2.5 pr-10 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50 transition-colors"
                />
                <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{error}</div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {mode === 'login' ? 'Entrar' : 'Criar conta'}
            </button>
          </form>

          <div className="mt-5 text-center">
            <button
              onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); }}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              {mode === 'login' ? 'Não tens conta? Cria uma' : 'Já tens conta? Inicia sessão'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}