import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import ProtectedRoute from '@/components/ProtectedRoute';

// Layout
import AppLayout from '@/components/layout/AppLayout';

// Auth Pages
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';

// Pages
import Dashboard from '@/pages/Dashboard';
import AdsAutopilot from '@/pages/AdsAutopilot';
import AdsManagement from '@/pages/AdsManagement';
import LearnerEngine from '@/pages/LearnerEngine';
import InventorySales from '@/pages/InventorySales';
import Logs from '@/pages/Logs';
import Settings from '@/pages/Settings';
import Products from '@/pages/Products';
import Report from '@/pages/Report';
import LogDeBids from '@/pages/LogDeBids';
import Diagnostico from '@/pages/Diagnostico';
import BidLogs from '@/pages/BidLogs';
import Analytics from '@/pages/Analytics';
import AmazonAdsCallback from '@/pages/AmazonAdsCallback';
import Recommendations from '@/pages/Recommendations';
import SearchTerms from '@/pages/SearchTerms';
import MetricsDashboard from '@/pages/MetricsDashboard';
import SpApiSetup from '@/pages/SpApiSetup';
import SpApiSelfAuth from '@/pages/SpApiSelfAuth';
import AmazonIntegracao from '@/pages/integracoes/Amazon';
import SystemHealth from '@/pages/SystemHealth';
import CampaignConfig from '@/pages/CampaignConfig';
import DaypartingDashboard from '@/pages/DaypartingDashboard';
import ManualInstrucoes from '@/pages/ManualInstrucoes';
import Alerts from '@/pages/Alerts';
import OptimizerPipeline from '@/pages/OptimizerPipeline';
import CurrencyAudit from '@/pages/CurrencyAudit';
import KeywordManagement from '@/pages/KeywordManagement';
import AmazonOAuthSetup from '@/pages/AmazonOAuthSetup';

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-cyan/20 border border-cyan/30 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-cyan/40 border-t-cyan rounded-full animate-spin" />
          </div>
          <p className="text-sm text-slate-500">A carregar LivingFinds...</p>
        </div>
      </div>
    );
  }

  if (authError) {
    if (authError.type === 'user_not_registered') return <UserNotRegisteredError />;
    if (authError.type === 'auth_required') { navigateToLogin(); return null; }
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/amazon-ads-callback" element={<AmazonAdsCallback />} />
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/ads" element={<AdsManagement />} />
          <Route path="/autopilot" element={<AdsAutopilot />} />
          <Route path="/learner" element={<LearnerEngine />} />
          <Route path="/inventory" element={<InventorySales />} />
          <Route path="/products" element={<Products />} />
          <Route path="/bids-log" element={<LogDeBids />} />
          <Route path="/bid-logs" element={<BidLogs />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/metrics" element={<MetricsDashboard />} />
          <Route path="/recommendations" element={<Recommendations />} />
          <Route path="/search-terms" element={<SearchTerms />} />
          <Route path="/diagnostico" element={<Diagnostico />} />
          <Route path="/report" element={<Report />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/sp-api-setup" element={<SpApiSetup />} />
          <Route path="/sp-api-self-auth" element={<SpApiSelfAuth />} />
          <Route path="/integracoes/amazon" element={<AmazonIntegracao />} />
          <Route path="/saude-do-sistema" element={<SystemHealth />} />
          <Route path="/configuracao-de-campanhas" element={<CampaignConfig />} />
          <Route path="/dayparting" element={<DaypartingDashboard />} />
          <Route path="/manual" element={<ManualInstrucoes />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/optimizer" element={<OptimizerPipeline />} />
          <Route path="/currency-audit" element={<CurrencyAudit />} />
          <Route path="/keyword-management" element={<KeywordManagement />} />
          <Route path="/amazon-oauth-setup" element={<AmazonOAuthSetup />} />
          {/* Redirects de rotas fundidas */}
          <Route path="/bid-logs" element={<Navigate to="/bids-log" replace />} />
          <Route path="/metrics" element={<Navigate to="/" replace />} />
          <Route path="/recommendations" element={<Navigate to="/learner" replace />} />
          <Route path="/dayparting" element={<Navigate to="/learner" replace />} />
          <Route path="/keyword-management" element={<Navigate to="/ads" replace />} />
          <Route path="/configuracao-de-campanhas" element={<Navigate to="/ads" replace />} />
          <Route path="/optimizer" element={<Navigate to="/learner" replace />} />
          {/* Redirects de rotas obsoletas */}
          <Route path="/transitions" element={<Navigate to="/products" replace />} />
          <Route path="/motor-config" element={<Navigate to="/learner" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;