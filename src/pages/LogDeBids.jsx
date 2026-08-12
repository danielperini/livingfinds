// Página legada substituída por /bid-logs (BidLogs.jsx).
// Mantida apenas como redirecionamento para compatibilidade.
import { Navigate } from 'react-router-dom';

export default function LogDeBids() {
  return <Navigate to="/bid-logs" replace />;
}