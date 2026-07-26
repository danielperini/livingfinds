/**
 * KeywordBankSection — seção hierárquica "Keyword Bank" com 4 sub-tabs:
 *   Terms | Suggested | Keyword Bank | Keyword Investigator
 *
 * Reutiliza os componentes existentes TermBankTab, AmazonSuggestionsTab,
 * KeywordBankTab e KeywordInvestigatorTab do Campaign Factory.
 */
import { useState } from 'react';
import { BookOpen, Star, Share2, Search } from 'lucide-react';

const SUB_TABS = [
  { key: 'terms',       label: 'Terms',                icon: Star },
  { key: 'suggested',   label: 'Suggested',            icon: Share2 },
  { key: 'bank',        label: 'Keyword Bank',         icon: BookOpen },
  { key: 'investigator',label: 'Keyword Investigator', icon: Search },
];

export default function KeywordBankSection({ children, defaultTab = 'terms', counts = {} }) {
  const [activeTab, setActiveTab] = useState(defaultTab);

  return (
    <div className="space-y-0">
      {/* Sub-tabs bar */}
      <div className="flex border-b border-surface-2 bg-[#0B0D14] overflow-x-auto scrollbar-thin">
        {SUB_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
              activeTab === t.key
                ? 'border-cyan text-cyan'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
            {counts[t.key] > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-surface-3 text-slate-400 text-[9px] font-bold">
                {counts[t.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="pt-4">
        {children(activeTab)}
      </div>
    </div>
  );
}