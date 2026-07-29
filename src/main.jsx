import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import '@/dashboardSeparatedChartsEntry.jsx'
import { installCampaignInsertionGuard } from '@/lib/installCampaignInsertionGuard'

installCampaignInsertionGuard()

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
