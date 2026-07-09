import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { base44 } from '@/api/base44Client';
import Products from '@/pages/Products';
import {
  CheckCircle2,
  Clock,
} from 'lucide-react';
import KickoffControlPanel from '@/components/products/KickoffControlPanel';
import StockDivergenceReport from '@/components/products/StockDivergenceReport';

function getSaoPauloParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  return Object.fromEntries(
    parts.map((part) => [
      part.type,
      part.value,
    ])
  );
}

function nextWindow(now = new Date()) {
  const parts = getSaoPauloParts(now);
  const hour = Number(parts.hour || 0);

  const day =
    `${parts.year}-` +
    `${parts.month}-` +
    `${parts.day}`;

  if (hour < 4) {
    return {
      label:
        'janela 00:00–04:00 em andamento',
      at: `${day}T04:00:00-03:00`,
    };
  }

  if (hour < 13) {
    return {
      label: 'hoje, 13:00–14:00',
      at: `${day}T13:00:00-03:00`,
    };
  }

  if (hour < 14) {
    return {
      label:
        'janela 13:00–14:00 em andamento',
      at: `${day}T14:00:00-03:00`,
    };
  }

  const tomorrow = new Date(
    `${day}T12:00:00-03:00`
  );

  tomorrow.setDate(
    tomorrow.getDate() + 1
  );

  const tomorrowParts =
    getSaoPauloParts(tomorrow);

  const tomorrowDay =
    `${tomorrowParts.year}-` +
    `${tomorrowParts.month}-` +
    `${tomorrowParts.day}`;

  return {
    label: 'amanhã, 00:00–04:00',
    at:
      `${tomorrowDay}` +
      'T00:00:00-03:00',
  };
}

function nextKickoffSlot(
  now = new Date()
) {
  const parts = getSaoPauloParts(now);
  const hour = Number(parts.hour || 0);

  const day =
    `${parts.year}-` +
    `${parts.month}-` +
    `${parts.day}`;

  if ([0, 1, 2, 3].includes(hour)) {
    return {
      hour,
      window:
        `${String(hour).padStart(
          2,
          '0'
        )}:00-` +
        `${String(hour + 1).padStart(
          2,
          '0'
        )}:00`,
      scheduledAt:
        new Date().toISOString(),
    };
  }

  if (hour === 13) {
    return {
      hour: 13,
      window: '13:00-14:00',
      scheduledAt:
        new Date().toISOString(),
    };
  }

  if (hour < 13) {
    return {
      hour: 13,
      window: '13:00-14:00',
      scheduledAt: new Date(
        `${day}T13:00:00-03:00`
      ).toISOString(),
    };
  }

  const tomorrow = new Date(
    `${day}T12:00:00-03:00`
  );

  tomorrow.setDate(
    tomorrow.getDate() + 1
  );

  const tomorrowParts =
    getSaoPauloParts(tomorrow);

  const tomorrowDay =
    `${tomorrowParts.year}-` +
    `${tomorrowParts.month}-` +
    `${tomorrowParts.day}`;

  return {
    hour: 0,
    window: '00:00-01:00',
    scheduledAt: new Date(
      `${tomorrowDay}` +
        'T00:00:00-03:00'
    ).toISOString(),
  };
}

function formatDateTime(value) {
  if (!value) {
    return 'ainda não registrada';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'ainda não registrada';
  }

  return date.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function latestQueueByAsin(records) {
  const result = {};

  for (const item of records || []) {
    const asin = String(
      item?.asin || ''
    )
      .trim()
      .toUpperCase();

    if (!asin) {
      continue;
    }

    /*
     * A consulta está ordenada da mais
     * recente para a mais antiga.
     */
    if (!result[asin]) {
      result[asin] = item;
    }
  }

  return result;
}

export default function ProductsScheduled() {
  const [account, setAccount] =
    useState(null);

  const [lastUpdate, setLastUpdate] =
    useState(null);

  const [status, setStatus] =
    useState('waiting');

  const [refreshKey, setRefreshKey] =
    useState(0);

  const [queueByAsin, setQueueByAsin] =
    useState({});

  const linkedAccountRef = useRef(null);

  const completedHandledRef = useRef(
    new Set()
  );

  const windowInfo = useMemo(
    () => nextWindow(),
    [lastUpdate]
  );

  const refreshCampaignLinks =
    useCallback(
      async (
        accountId,
        force = false
      ) => {
        if (!accountId) {
          return;
        }

        if (
          !force &&
          linkedAccountRef.current ===
            accountId
        ) {
          return;
        }

        linkedAccountRef.current =
          accountId;

        try {
          const response =
            await base44.functions.invoke(
              'fixProductCampaignLinks',
              {
                amazon_account_id:
                  accountId,
              }
            );

          if (response?.data?.ok) {
            setRefreshKey(
              (current) =>
                current + 1
            );
          }
        } catch {
          linkedAccountRef.current =
            null;
        }
      },
      []
    );

  const readQueue = useCallback(
    async (accountId) => {
      if (!accountId) {
        return;
      }

      const records =
        await base44.entities
          .ProductKickoffQueue
          .filter(
            {
              amazon_account_id:
                accountId,
            },
            '-created_date',
            500
          )
          .catch(() => []);

      const latest =
        latestQueueByAsin(records);

      setQueueByAsin(latest);

      const completedItems =
        Object.values(latest).filter(
          (item) =>
            String(
              item?.status || ''
            ).toLowerCase() ===
            'completed'
        );

      const hasNewCompleted =
        completedItems.some(
          (item) =>
            item?.id &&
            !completedHandledRef
              .current
              .has(item.id)
        );

      completedItems.forEach(
        (item) => {
          if (item?.id) {
            completedHandledRef
              .current
              .add(item.id);
          }
        }
      );

      if (hasNewCompleted) {
        linkedAccountRef.current =
          null;

        await refreshCampaignLinks(
          accountId,
          true
        );
      }
    },
    [refreshCampaignLinks]
  );

  const readStatus =
    useCallback(async () => {
      try {
        const me =
          await base44.auth.me();

        let accounts =
          await base44.entities
            .AmazonAccount
            .filter({
              user_id: me.id,
            });

        if (!accounts.length) {
          accounts =
            await base44.entities
              .AmazonAccount
              .filter({
                status: 'connected',
              });
        }

        if (!accounts.length) {
          accounts =
            await base44.entities
              .AmazonAccount
              .list();
        }

        const current =
          accounts[0] || null;

        setAccount(current);

        if (!current) {
          return;
        }

        await readQueue(current.id);

        const logs =
          await base44.entities
            .SyncExecutionLog
            .filter(
              {
                amazon_account_id:
                  current.id,
                operation:
                  'products_ads_window_sync',
              },
              '-completed_at',
              1
            )
            .catch(() => []);

        const latest =
          logs[0] || null;

        const nextValue =
          latest?.completed_at ||
          current
            .products_ads_last_sync_at ||
          current.last_sync_at ||
          null;

        setStatus(
          latest?.status ||
            current
              .products_ads_sync_status ||
            'waiting'
        );

        setLastUpdate(
          (previous) => {
            if (
              previous &&
              nextValue &&
              previous !== nextValue
            ) {
              setRefreshKey(
                (currentKey) =>
                  currentKey + 1
              );
            }

            return nextValue;
          }
        );
      } catch {
        setStatus('error');
      }
    }, [
      readQueue,
      refreshCampaignLinks,
    ]);

  const retryKickoff =
    useCallback(
      async (queueItem) => {
        if (!queueItem?.id) {
          return;
        }

        const slot =
          nextKickoffSlot();

        const asin = String(
          queueItem.asin || ''
        )
          .trim()
          .toUpperCase();

        /*
         * Atualização imediata da tela.
         */
        setQueueByAsin(
          (current) => ({
            ...current,
            [asin]: {
              ...queueItem,
              status: 'scheduled',
              attempt_count: 0,
              last_error: null,
              queue_hour:
                slot.hour,
              queue_window:
                slot.window,
              scheduled_at:
                slot.scheduledAt,
            },
          })
        );

        await base44.entities
          .ProductKickoffQueue
          .update(
            queueItem.id,
            {
              status: 'scheduled',
              attempt_count: 0,
              last_error: null,
              queue_hour:
                slot.hour,
              queue_window:
                slot.window,
              scheduled_at:
                slot.scheduledAt,
            }
          );

        await readQueue(
          account?.id
        );
      },
      [
        account?.id,
        readQueue,
      ]
    );

  /*
   * Atualização automática a cada
   * 5 minutos (evita Rate Limit).
   */
  useEffect(() => {
    readStatus();

    const timer =
      window.setInterval(
        readStatus,
        300000
      );

    return () => {
      window.clearInterval(timer);
    };
  }, [readStatus]);

  /*
   * Atualiza a fila imediatamente
   * quando a modal confirmar o
   * Kick-off.
   */
  useEffect(() => {
    const handleKickoffQueued =
      () => {
        if (!account?.id) {
          return;
        }

        readQueue(account.id);

        window.setTimeout(() => {
          readQueue(account.id);
        }, 700);

        window.setTimeout(() => {
          readQueue(account.id);
        }, 1800);
      };

    window.addEventListener(
      'product-kickoff-queued',
      handleKickoffQueued
    );

    return () => {
      window.removeEventListener(
        'product-kickoff-queued',
        handleKickoffQueued
      );
    };
  }, [
    account?.id,
    readQueue,
  ]);

  /*
   * Atualiza os botões já criados
   * pelo arquivo Products.jsx.
   */
  useEffect(() => {
    const queueEntries =
      Object.entries(queueByAsin);

    const findKickoffButton = (
      row
    ) => {
      const buttons = Array.from(
        row.querySelectorAll(
          'button'
        )
      );

      return buttons.find(
        (button) => {
          const text = String(
            button.textContent || ''
          ).trim();

          return (
            /kick-off/i.test(text) ||
            /aguardando chamada/i.test(
              text
            ) ||
            /programando/i.test(text) ||
            /falha no kick-off/i.test(
              text
            ) ||
            /atualizando campanha/i.test(
              text
            )
          );
        }
      );
    };

    const saveOriginalButton = (
      button
    ) => {
      if (
        button.dataset
          .kickoffOriginalHtml
      ) {
        return;
      }

      button.dataset
        .kickoffOriginalHtml =
        button.innerHTML;

      button.dataset
        .kickoffOriginalClass =
        button.className;

      button.dataset
        .kickoffOriginalDisabled =
        button.disabled
          ? 'true'
          : 'false';
    };

    const restoreButton = (
      button,
      row
    ) => {
      if (
        !button?.dataset
          ?.kickoffManaged
      ) {
        return;
      }

      if (
        button.dataset
          .kickoffOriginalHtml
      ) {
        button.innerHTML =
          button.dataset
            .kickoffOriginalHtml;
      }

      if (
        button.dataset
          .kickoffOriginalClass
      ) {
        button.className =
          button.dataset
            .kickoffOriginalClass;
      }

      button.disabled =
        button.dataset
          .kickoffOriginalDisabled ===
        'true';

      delete button.dataset
        .kickoffManaged;

      const helper =
        row.querySelector(
          '[data-kickoff-queue-status="true"]'
        );

      helper?.remove();
    };

    const setButtonStatus = (
      button,
      label
    ) => {
      const currentText =
        String(
          button.textContent || ''
        ).trim();

      if (currentText !== label) {
        button.textContent =
          label;
      }
    };

    const getHelper = (
      row,
      button
    ) => {
      let helper =
        row.querySelector(
          '[data-kickoff-queue-status="true"]'
        );

      if (!helper) {
        helper =
          document.createElement(
            'div'
          );

        helper.setAttribute(
          'data-kickoff-queue-status',
          'true'
        );

        const parent =
          button.parentElement;

        if (parent) {
          parent.classList.add(
            'flex-wrap'
          );

          parent.appendChild(
            helper
          );
        }
      }

      return helper;
    };

    const renderSimpleHelper = (
      helper,
      text,
      className,
      key
    ) => {
      if (
        helper.dataset.renderKey ===
        key
      ) {
        return;
      }

      helper.dataset.renderKey =
        key;

      helper.textContent =
        text;

      helper.className =
        className;
    };

    const renderFailedHelper = (
      helper,
      queueItem
    ) => {
      const renderKey =
        `failed-${queueItem.id}-` +
        `${queueItem.last_error || ''}`;

      if (
        helper.dataset.renderKey ===
        renderKey
      ) {
        return;
      }

      helper.dataset.renderKey =
        renderKey;

      helper.innerHTML = '';

      helper.className =
        'basis-full mt-1 ' +
        'flex flex-col ' +
        'items-start gap-1 ' +
        'max-w-[240px]';

      const errorText =
        document.createElement(
          'p'
        );

      errorText.className =
        'text-[10px] ' +
        'text-red-400';

      errorText.textContent =
        queueItem.last_error ||
        'Falha no Kick-off';

      const retryButton =
        document.createElement(
          'button'
        );

      retryButton.type =
        'button';

      retryButton.className =
        'text-[10px] ' +
        'font-semibold ' +
        'text-cyan ' +
        'hover:underline';

      retryButton.textContent =
        'Tentar novamente';

      retryButton.addEventListener(
        'click',
        async (event) => {
          event.preventDefault();
          event.stopPropagation();

          retryButton.disabled =
            true;

          retryButton.textContent =
            'Reprogramando...';

          try {
            await retryKickoff(
              queueItem
            );
          } catch (error) {
            retryButton.disabled =
              false;

            retryButton.textContent =
              'Tentar novamente';

            errorText.textContent =
              error?.message ||
              'Não foi possível reprogramar.';
          }
        }
      );

      helper.appendChild(
        errorText
      );

      helper.appendChild(
        retryButton
      );
    };

    const applyQueueStatuses =
      () => {
        const rows =
          document.querySelectorAll(
            'tbody tr'
          );

        rows.forEach((row) => {
          const rowText =
            String(
              row.textContent || ''
            ).toUpperCase();

          const button =
            findKickoffButton(row);

          if (!button) {
            return;
          }

          const queueEntry =
            queueEntries.find(
              ([asin]) =>
                rowText.includes(
                  asin
                )
            );

          if (!queueEntry) {
            restoreButton(
              button,
              row
            );

            return;
          }

          const [, queueItem] =
            queueEntry;

          const queueStatus =
            String(
              queueItem?.status || ''
            ).toLowerCase();

          saveOriginalButton(
            button
          );

          const helper =
            getHelper(
              row,
              button
            );

          if (
            queueStatus ===
            'scheduled'
          ) {
            button.dataset
              .kickoffManaged =
              'scheduled';

            button.disabled =
              true;

            setButtonStatus(
              button,
              'Aguardando chamada'
            );

            button.classList.add(
              'opacity-70',
              'cursor-not-allowed'
            );

            renderSimpleHelper(
              helper,
              queueItem
                ?.queue_window
                ? `Janela: ${queueItem.queue_window}`
                : 'Pedido salvo na fila para execução',
              'basis-full mt-1 ' +
                'text-[10px] ' +
                'text-cyan ' +
                'max-w-[230px]',
              `scheduled-${queueItem.id}-${queueItem.queue_window || ''}`
            );

            return;
          }

          if (
            queueStatus ===
            'processing'
          ) {
            button.dataset
              .kickoffManaged =
              'processing';

            button.disabled =
              true;

            setButtonStatus(
              button,
              'Programando'
            );

            button.classList.add(
              'opacity-70',
              'cursor-not-allowed'
            );

            renderSimpleHelper(
              helper,
              'Enviando campanhas para a Amazon',
              'basis-full mt-1 ' +
                'text-[10px] ' +
                'text-amber-400 ' +
                'max-w-[230px]',
              `processing-${queueItem.id}`
            );

            return;
          }

          if (
            queueStatus ===
            'failed'
          ) {
            button.dataset
              .kickoffManaged =
              'failed';

            button.disabled =
              true;

            setButtonStatus(
              button,
              'Falha no Kick-off'
            );

            button.classList.add(
              'opacity-70',
              'cursor-not-allowed'
            );

            renderFailedHelper(
              helper,
              queueItem
            );

            return;
          }

          if (
            queueStatus ===
            'completed'
          ) {
            button.dataset
              .kickoffManaged =
              'completed';

            button.disabled =
              true;

            setButtonStatus(
              button,
              'Atualizando campanha'
            );

            button.classList.add(
              'opacity-70',
              'cursor-not-allowed'
            );

            renderSimpleHelper(
              helper,
              'Kick-off concluído. Atualizando vínculo da campanha...',
              'basis-full mt-1 ' +
                'text-[10px] ' +
                'text-emerald-400 ' +
                'max-w-[230px]',
              `completed-${queueItem.id}`
            );

            return;
          }

          restoreButton(
            button,
            row
          );
        });
      };

    applyQueueStatuses();

    const observer =
      new MutationObserver(() => {
        applyQueueStatuses();
      });

    observer.observe(
      document.body,
      {
        childList: true,
        subtree: true,
      }
    );

    return () => {
      observer.disconnect();
    };
  }, [
    queueByAsin,
    retryKickoff,
  ]);

  const pendingCount =
    Object.values(
      queueByAsin
    ).filter((item) =>
      [
        'scheduled',
        'processing',
      ].includes(
        String(
          item?.status || ''
        ).toLowerCase()
      )
    ).length;

  return (
    <div className="space-y-4">
      <div className="mx-6 mt-6 rounded-xl border border-cyan/20 bg-cyan/5 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          {status ===
          'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5" />
          ) : (
            <Clock className="w-5 h-5 text-cyan mt-0.5" />
          )}

          <div>
            <p className="text-sm font-semibold text-white">
              Produtos & Ads —
              atualização automática
              ativa
            </p>

            <p className="text-xs text-slate-400 mt-1">
              Campanhas, catálogo,
              estoque e vínculos são
              atualizados
              automaticamente nas
              janelas 00:00–04:00 e
              13:00–14:00.
            </p>

            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-slate-500">
              <span>
                Última atualização:{' '}
                {formatDateTime(
                  lastUpdate
                )}
              </span>

              <span>
                Próxima atualização:{' '}
                {windowInfo.label}
              </span>

              {pendingCount > 0 && (
                <span className="text-cyan">
                  Kick-offs aguardando:{' '}
                  {pendingCount}
                </span>
              )}

              {account?.status && (
                <span>
                  Conta Amazon:{' '}
                  {account.status ===
                  'connected'
                    ? 'conectada'
                    : account.status}
                </span>
              )}
            </div>
          </div>
        </div>


      </div>

      <StockDivergenceReport accountId={account?.id} />

      <KickoffControlPanel
        accountId={account?.id}
        onRetry={retryKickoff}
      />

      <Products
        key={refreshKey}
      />
    </div>
  );
}