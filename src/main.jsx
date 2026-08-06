import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import '@/styles/premium-theme.css'
import '@/styles/workspaces-premium.css'
import '@/styles/sortable-tables.css'
import '@/dashboardSeparatedChartsEntry.jsx'
import { installCampaignInsertionGuard } from '@/lib/installCampaignInsertionGuard'
import { installGlobalTableSorting } from '@/lib/installGlobalTableSorting'

installCampaignInsertionGuard()
installGlobalTableSorting()

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
