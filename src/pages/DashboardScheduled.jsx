/**
 * DashboardScheduled — 100% passivo, apenas lê banco de dados.
 * Nenhuma chamada de API Amazon ou função de backend é feita aqui.
 * A sincronização ocorre exclusivamente via automações agendadas no backend.
 */
import Dashboard from '@/pages/Dashboard';

export default function DashboardScheduled() {
  return <Dashboard />;
}