import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import '@/styles/premium-theme.css'
import '@/styles/workspaces-premium.css'
import '@/styles/sortable-tables.css'
import '@/styles/app-premium-normalization.css'
import '@/styles/black-workspace-tables.css'
import '@/dashboardSeparatedChartsEntry.jsx'
import { installCampaignInsertionGuard } from '@/lib/installCampaignInsertionGuard'
import { installGlobalTableSorting } from '@/lib/installGlobalTableSorting'
import { installUnlimitedKeywordReads } from '@/lib/installUnlimitedKeywordReads'
import { installActiveCampaignReads } from '@/lib/installActiveCampaignReads'
import { installAutomaticNegativeHarvest } from '@/lib/installAutomaticNegativeHarvest'

installCampaignInsertionGuard()
installGlobalTableSorting()
installUnlimitedKeywordReads()
installActiveCampaignReads()
installAutomaticNegativeHarvest()

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
